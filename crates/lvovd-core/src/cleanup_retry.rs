//! Three delayed retries for transient locks; exhausted cleanup remains owned.
use std::time::{Duration, Instant};
#[derive(Default)]
pub(crate) struct Retry {
    failures: usize,
    next: Option<Instant>,
}
impl Retry {
    pub fn due(&self) -> bool {
        self.next.is_some_and(|at| Instant::now() >= at)
    }
    pub fn failed(&mut self) {
        self.next = [200, 500, 1000]
            .get(self.failures)
            .map(|ms| Instant::now() + Duration::from_millis(*ms));
        self.failures += 1;
    }
}
