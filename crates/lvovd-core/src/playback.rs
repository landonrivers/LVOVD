//! Private Unix-socket broker for Linux's GStreamer source. The decoder receives
//! bounded bytes, never an owned file path or descriptor with unrestricted reads.
use crate::assets::Assets;
use crate::process::CancellationToken;
use lvovd_media_ipc as wire;
use std::{io, os::unix::net::UnixListener as StdListener, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Mutex,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

pub struct Broker {
    cancel: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl Broker {
    pub fn start(
        listener: StdListener,
        token: [u8; 32],
        assets: Arc<Assets>,
        changed: Arc<dyn Fn() + Send + Sync>,
    ) -> io::Result<Self> {
        listener.set_nonblocking(true)?;
        let listener = UnixListener::from_std(listener)?;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    Some(_) = clients.join_next(), if !clients.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        // The directory is private too; peer credentials reject other UIDs.
                        // SAFETY: geteuid has no memory preconditions.
                        let uid = unsafe { libc::geteuid() };
                        if clients.len() >= wire::MAX_CONNECTIONS || !stream.peer_cred().is_ok_and(|cred| cred.uid() == uid) { continue; }
                        let assets = assets.clone(); let stop = stop.clone(); let changed = changed.clone();
                        clients.spawn(async move { let _ = connection(stream, token, assets, stop, changed).await; });
                    }
                }
            }
            stop.cancel();
            while clients.join_next().await.is_some() {}
        });
        Ok(Self {
            cancel,
            task: Mutex::new(Some(task)),
        })
    }
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn connection(
    mut stream: UnixStream,
    token: [u8; 32],
    assets: Arc<Assets>,
    stop: CancellationToken,
    changed: Arc<dyn Fn() + Send + Sync>,
) -> io::Result<()> {
    let mut hello = [0; wire::HELLO_BYTES];
    tokio::select! { biased; _ = stop.cancelled() => return Ok(()), result = timeout(wire::IO_TIMEOUT, stream.read_exact(&mut hello)) => { result??; } }
    let id = wire::authorize(&hello, &token).ok_or_else(wire::invalid)?;
    let asset = assets.lease(id).map_err(|_| wire::invalid())?;
    if asset.source.inspection.mime.is_none() {
        return Err(wire::invalid());
    }
    let revoked = asset.cancellation();
    let result = async {
        let mut greeting = [0; 9]; greeting[1..].copy_from_slice(&asset.source.size.to_le_bytes());
        tokio::select! { biased; _ = stop.cancelled() => return Ok(()), _ = revoked.cancelled() => return Ok(()), result = timeout(wire::IO_TIMEOUT, stream.write_all(&greeting)) => { result??; } }
        loop {
            let mut request = [0; 12];
            tokio::select! { biased; _ = stop.cancelled() => return Ok(()), _ = revoked.cancelled() => return Ok(()), result = async {
                timeout(wire::IDLE_TIMEOUT, stream.read_exact(&mut request[..1])).await??;
                timeout(wire::IO_TIMEOUT, stream.read_exact(&mut request[1..])).await??;
                Ok::<_, io::Error>(())
            } => result? }
            let (offset, length) = wire::read_range(request, asset.source.size).ok_or_else(wire::invalid)?;
            let lease = asset.clone();
            // Keep blocking disk access off the async/UI thread and wait for its
            // completion before retiring the lease, even during cancellation.
            let bytes = tokio::task::spawn_blocking(move || lease.read(offset, length)).await.map_err(|_| wire::invalid())?.map_err(|_| wire::invalid())?;
            if revoked.is_cancelled() || stop.is_cancelled() { return Ok(()); }
            let mut response = [0; 5]; response[1..].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
            tokio::select! { biased; _ = stop.cancelled() => return Ok(()), _ = revoked.cancelled() => return Ok(()), result = timeout(wire::IO_TIMEOUT, async { stream.write_all(&response).await?; stream.write_all(&bytes).await }) => { result??; } }
        }
    }.await;
    drop(stream);
    drop(asset);
    if assets.pending_cleanup().contains(&id) {
        let _ = assets.remove(id);
        changed();
    }
    result
}
