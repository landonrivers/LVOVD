//! Bound both active reads and waiting protocol requests without rejecting a
//! decoder's ordinary burst of ranges during file selection.
use crate::{AppError, Result, process::CancellationToken};
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const ACTIVE_READS: usize = 4;
pub const PENDING_REQUESTS: usize = 32;
const QUEUE_DEADLINE: Duration = Duration::from_secs(5);

pub struct MediaAdmission {
    active: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    cancel: CancellationToken,
    deadline: Duration,
}

pub struct Ticket {
    active: Arc<Semaphore>,
    cancel: CancellationToken,
    deadline: Duration,
    pending: OwnedSemaphorePermit,
}

/// Keep this guard through the blocking read, response delivery and cleanup.
/// Dropping a waiting task does not release a guard moved into a blocking read.
pub struct ActiveRead {
    _active: OwnedSemaphorePermit,
    _pending: OwnedSemaphorePermit,
}

impl MediaAdmission {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            active: Arc::new(Semaphore::new(ACTIVE_READS)),
            pending: Arc::new(Semaphore::new(PENDING_REQUESTS)),
            cancel,
            deadline: QUEUE_DEADLINE,
        }
    }

    /// Admission is synchronous so even tasks waiting for a read stay bounded.
    pub fn admit(&self) -> Result<Ticket> {
        if self.cancel.is_cancelled() {
            return Err(closing());
        }
        let pending = self
            .pending
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::new("MEDIA_BUSY", "Too many media requests are pending."))?;
        Ok(Ticket {
            active: self.active.clone(),
            cancel: self.cancel.clone(),
            deadline: self.deadline,
            pending,
        })
    }

    pub async fn shutdown(&self) {
        self.cancel.cancel();
        // Pending tickets cancel, but active blocking reads keep their permits
        // until they actually exit. Do not delete owned storage before then.
        let _drained = self.pending.acquire_many(PENDING_REQUESTS as u32).await;
    }
}

fn closing() -> AppError {
    AppError::new("MEDIA_CLOSING", "Media playback is closing.")
}

impl Ticket {
    pub async fn wait(self) -> Result<ActiveRead> {
        let active = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(closing()),
            result = tokio::time::timeout(self.deadline, self.active.acquire_owned()) => {
                result.map_err(|_| AppError::new("MEDIA_QUEUE_TIMEOUT", "Media reads did not become available in time."))?
                    .map_err(|_| closing())?
            }
        };
        Ok(ActiveRead {
            _active: active,
            _pending: self.pending,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_new_file_waits_for_old_reads_instead_of_being_rejected() {
        let gate = MediaAdmission::new(CancellationToken::new());
        let mut old = Vec::new();
        for _ in 0..ACTIVE_READS {
            old.push(gate.admit().unwrap().wait().await.unwrap());
        }
        let next = gate.admit().unwrap().wait();
        tokio::pin!(next);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut next)
                .await
                .is_err()
        );
        drop(old.pop());
        let next = tokio::time::timeout(Duration::from_secs(1), next)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(gate.active.available_permits(), 0);
        drop(next);
        drop(old);
        gate.shutdown().await;
    }

    #[tokio::test]
    async fn admission_and_waiting_time_are_bounded_and_cancelled_tickets_do_not_read() {
        let mut gate = MediaAdmission::new(CancellationToken::new());
        gate.deadline = Duration::from_millis(20);
        let tickets: Vec<_> = (0..PENDING_REQUESTS)
            .map(|_| gate.admit().unwrap())
            .collect();
        assert_eq!(gate.admit().err().unwrap().code, "MEDIA_BUSY");
        drop(tickets);
        let mut active = Vec::new();
        for _ in 0..ACTIVE_READS {
            active.push(gate.admit().unwrap().wait().await.unwrap());
        }
        assert_eq!(
            gate.admit().unwrap().wait().await.err().unwrap().code,
            "MEDIA_QUEUE_TIMEOUT"
        );
        let pending = gate.admit().unwrap();
        gate.cancel.cancel();
        assert_eq!(pending.wait().await.err().unwrap().code, "MEDIA_CLOSING");
        assert_eq!(gate.admit().err().unwrap().code, "MEDIA_CLOSING");
        assert_eq!(
            gate.pending.available_permits(),
            PENDING_REQUESTS - ACTIVE_READS
        );
        drop(active);
        gate.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_blocking_reader_even_if_its_async_waiter_is_aborted() {
        let gate = Arc::new(MediaAdmission::new(CancellationToken::new()));
        let active = gate.admit().unwrap().wait().await.unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _active = active;
                started.send(()).unwrap();
                finish.recv().unwrap();
            })
            .await
            .unwrap();
        });
        ready.await.unwrap();
        waiter.abort();
        let shutdown = gate.shutdown();
        tokio::pin!(shutdown);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut shutdown)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .unwrap();
    }
}
