//! Bounded external-tool execution with tracked, cancellation-safe ownership.
use crate::{AppError, Result};
use std::{
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
pub use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub struct Request<'a> {
    pub executable: &'a Path,
    pub args: &'a [OsString],
    pub deadline: Duration,
    pub diagnostic_limit: usize,
    pub cancel: &'a CancellationToken,
}
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub out_time_us: Option<u64>,
}
enum Capture {
    All,
    Progress(tokio::sync::watch::Sender<Progress>),
}

/// A dropped waiter cancels its worker; it does not abort the supervising task.
/// Move all processing-slot/file/reservation guards into `run_owned` so their
/// destructors run only after the OS confirms the process tree has exited.
pub struct Supervisor {
    admission: Mutex<()>,
    tasks: TaskTracker,
    closing: CancellationToken,
}
impl Default for Supervisor {
    fn default() -> Self {
        Self {
            admission: Mutex::new(()),
            tasks: TaskTracker::new(),
            closing: CancellationToken::new(),
        }
    }
}
impl Supervisor {
    pub async fn run_owned<G: Send + 'static>(
        &self,
        executable: &Path,
        args: &[OsString],
        deadline: Duration,
        limit: usize,
        cancel: &CancellationToken,
        ownership: G,
    ) -> Result<Output> {
        self.supervise(
            Request {
                executable,
                args,
                deadline,
                diagnostic_limit: limit,
                cancel,
            },
            Capture::All,
            ownership,
        )
        .await
    }
    /// Long encodes stream progress into a single replaceable snapshot. Captured
    /// diagnostic bytes remain bounded independently of the operation's length.
    pub async fn run_processing_owned<G: Send + 'static>(
        &self,
        request: Request<'_>,
        progress: tokio::sync::watch::Sender<Progress>,
        ownership: G,
    ) -> Result<Output> {
        self.supervise(request, Capture::Progress(progress), ownership)
            .await
    }
    async fn supervise<G: Send + 'static>(
        &self,
        request: Request<'_>,
        capture: Capture,
        ownership: G,
    ) -> Result<Output> {
        let Request {
            executable,
            args,
            deadline,
            diagnostic_limit: limit,
            cancel,
        } = request;
        let local_cancel = cancel.child_token();
        let _cancel_when_dropped = local_cancel.clone().drop_guard();
        let closing = self.closing.clone();
        let executable = executable.to_owned();
        let args = args.to_vec();
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let _admission = self.admission.lock().unwrap();
            if self.closing.is_cancelled() {
                return Err(AppError::new("CANCELLED", "Tool supervision is closing."));
            }
            self.tasks.spawn(async move {
                let _ownership = ownership;
                let work = run_inner(&executable, &args, deadline, limit, &local_cancel, capture);
                tokio::pin!(work);
                let result = tokio::select! {
                    biased;
                    _=closing.cancelled()=>{local_cancel.cancel();work.await},
                    result=&mut work=>result,
                };
                // Release caller-owned guards before signalling that admission
                // can be reused. The process tree has already been confirmed.
                drop(_ownership);
                let _ = send.send(result);
            });
        }
        receive.await.map_err(|_| {
            AppError::new("TOOL_SUPERVISION", "Tool supervision ended unexpectedly.")
        })?
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let _admission = self.admission.lock().unwrap();
            self.closing.cancel();
            self.tasks.close();
        }
        tokio::time::timeout(Duration::from_secs(5), self.tasks.wait())
            .await
            .map_err(|_| {
                AppError::new(
                    "TOOL_EXIT_PENDING",
                    "Tool exit is still pending; resources remain owned. Try closing again.",
                )
            })
    }
}
fn supervisor() -> &'static Supervisor {
    static INSTANCE: OnceLock<Supervisor> = OnceLock::new();
    INSTANCE.get_or_init(Supervisor::default)
}
pub async fn shutdown() -> Result<()> {
    supervisor().shutdown().await
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

async fn read_bounded(
    mut pipe: impl AsyncRead + Unpin,
    limit: usize,
    captured: &AtomicUsize,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .map_err(|_| AppError::new("TOOL_IO", "Could not read tool output."))?;
        if count == 0 {
            return Ok(bytes);
        }
        if captured
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                total.checked_add(count).filter(|total| *total <= limit)
            })
            .is_err()
        {
            return Err(AppError::new(
                "TOOL_OUTPUT_LIMIT",
                "Tool output exceeded its limit.",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

async fn read_progress(
    mut pipe: impl AsyncRead + Unpin,
    progress: tokio::sync::watch::Sender<Progress>,
) -> Result<Vec<u8>> {
    let mut line = Vec::with_capacity(256);
    let mut buffer = [0u8; 4096];
    loop {
        let count = pipe
            .read(&mut buffer)
            .await
            .map_err(|_| AppError::new("TOOL_IO", "Could not read tool progress."))?;
        if count == 0 {
            return Ok(vec![]);
        }
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if let Some(raw) = line.strip_prefix(b"out_time_us=")
                    && raw.iter().all(u8::is_ascii_digit)
                    && let Ok(raw) = std::str::from_utf8(raw)
                    && let Ok(time) = raw.parse::<u64>()
                {
                    progress.send_replace(Progress {
                        out_time_us: Some(time),
                    });
                }
                line.clear();
            } else {
                if line.len() >= 8192 {
                    return Err(AppError::new(
                        "TOOL_OUTPUT_LIMIT",
                        "Tool progress exceeded its line limit.",
                    ));
                }
                line.push(*byte);
            }
        }
    }
}

pub async fn run(
    executable: &Path,
    args: &[OsString],
    deadline: Duration,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Output> {
    supervisor()
        .run_owned(executable, args, deadline, limit, cancel, ())
        .await
}
async fn run_inner(
    executable: &Path,
    args: &[OsString],
    deadline: Duration,
    limit: usize,
    cancel: &CancellationToken,
    capture: Capture,
) -> Result<Output> {
    if cancel.is_cancelled() {
        return Err(AppError::new("CANCELLED", "Operation cancelled."));
    }
    if !executable.is_absolute() {
        return Err(AppError::new(
            "TOOL_PATH",
            "An absolute tool path is required.",
        ));
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Never inherit runtime injection or plugin configuration from the launching shell.
    for key in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "FFREPORT",
        "LVOVD_MEDIA_TOKEN",
        "LVOVD_MEDIA_SOCKET",
    ] {
        command.env_remove(key);
    }
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000 | 0x00000004); // hidden + suspended until assigned to the job
    let mut child = command.spawn().map_err(|e| {
        AppError::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                "TOOL_MISSING"
            } else {
                "TOOL_START"
            },
            "The required tool could not start. Check Runtime status.",
        )
    })?;
    let pid = child
        .id()
        .ok_or_else(|| AppError::new("TOOL_START", "Tool did not provide a process identity."))?;
    let mut tree = match ProcessTree::attach(pid) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let captured = AtomicUsize::new(0);
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(AppError::new("CANCELLED", "Operation cancelled.")),
        result = tokio::time::timeout(deadline, async {
            let (stdout, stderr, status) = tokio::try_join!(
                async {match capture {Capture::All=>read_bounded(stdout,limit,&captured).await,Capture::Progress(progress)=>read_progress(stdout,progress).await}}, read_bounded(stderr, limit, &captured),
                async {
                    let status=child.wait().await;
                    // Retire descendants before waiting for inherited pipes.
                    tree.terminate();
                    status.map_err(|_| AppError::new("TOOL_EXIT", "Could not confirm tool exit."))
                }
            )?;
            if !status.success() { return Err(AppError::new("TOOL_FAILED", "The tool rejected this operation.")); }
            Ok(Output { stdout, stderr })
        }) => result.unwrap_or_else(|_| Err(AppError::new("TOOL_TIMEOUT", "The tool exceeded its time limit.")))
    };
    // Also retire descendants that outlived a successful parent.
    tree.terminate();
    let _ = child.start_kill();
    let parent_exit = child.wait().await;
    // A successful parent can leave descendants behind. Signalling the group
    // or Job Object is not itself proof that those descendants have exited.
    // Keep supervision/ownership if the OS cannot yet confirm completion.
    while !tree.exited() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    parent_exit.map_err(|_| AppError::new("TOOL_EXIT", "Could not read the tool exit status."))?;
    result
}

#[cfg(unix)]
struct ProcessTree {
    pid: u32,
    confirmed: bool,
}
#[cfg(unix)]
impl ProcessTree {
    fn attach(pid: u32) -> Result<Self> {
        Ok(Self {
            pid,
            confirmed: false,
        })
    }
    fn terminate(&self) {
        // SAFETY: the child created its own group before exec; the negative ID targets only that group.
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }
    fn exited(&mut self) -> bool {
        // SAFETY: signal zero probes only the dedicated child process group.
        let result = unsafe { libc::kill(-(self.pid as i32), 0) };
        self.confirmed =
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        self.confirmed
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.confirmed {
            self.terminate();
        }
    }
}

#[cfg(windows)]
struct ProcessTree {
    handle: windows_sys::Win32::Foundation::HANDLE,
    completion: windows_sys::Win32::Foundation::HANDLE,
    members: Mutex<Members>,
    confirmed: bool,
}
#[cfg(windows)]
struct Members {
    observed: u32,
    handles: Vec<usize>,
    valid: bool,
}
#[cfg(windows)]
// SAFETY: this exclusively owned kernel handle is never accessed after Drop.
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
// SAFETY: shared access only invokes idempotent kernel operations on the live
// handle. Rust requires exclusive access for confirmation state and Drop.
unsafe impl Sync for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn attach(pid: u32) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::*,
            System::{Diagnostics::ToolHelp::*, IO::*, JobObjects::*, Threading::*},
        };
        let error = || {
            AppError::new(
                "TOOL_CONTAINMENT",
                "Could not contain the tool process; it was not allowed to run.",
            )
        };
        // SAFETY: all handles are checked, structures initialized, and handles closed on every path.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(error());
            }
            let completion =
                CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
            if completion.is_null() {
                CloseHandle(job);
                return Err(error());
            }
            let tree = Self {
                handle: job,
                completion,
                members: Mutex::new(Members {
                    observed: 0,
                    handles: vec![],
                    valid: true,
                }),
                confirmed: false,
            };
            let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                CompletionKey: std::ptr::null_mut(),
                CompletionPort: completion,
            };
            if SetInformationJobObject(
                job,
                JobObjectAssociateCompletionPortInformation,
                &association as *const _ as *const _,
                std::mem::size_of_val(&association) as u32,
            ) == 0
            {
                return Err(error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(error());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(error());
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                return Err(error());
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(error());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut found = false;
            let mut more = Thread32First(snapshot, &mut entry);
            while more != 0 {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        found = ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                    break;
                }
                more = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            if !found {
                return Err(error());
            }
            Ok(tree)
        }
    }
    fn terminate(&self) {
        self.collect_members();
        // SAFETY: this instance owns a live job handle; termination is idempotent.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
    fn collect_members(&self) {
        use windows_sys::Win32::{
            Foundation::*,
            System::{IO::*, SystemServices::JOB_OBJECT_MSG_NEW_PROCESS, Threading::*},
        };
        let mut members = self.members.lock().unwrap();
        // Messages are not assumed infallible: the final accounting total must
        // match observed NEW_PROCESS events before ownership can be released.
        // Holding handles also prevents PID reuse from confusing exit checks.
        for _ in 0..8192 {
            let (mut message, mut key, mut value) = (0, 0, std::ptr::null_mut());
            // SAFETY: the completion port is live; all output pointers are valid.
            let ok = unsafe {
                GetQueuedCompletionStatus(self.completion, &mut message, &mut key, &mut value, 0)
            };
            if ok == 0 {
                // A drained port is ordinary; other failures remain unconfirmed.
                if unsafe { GetLastError() } != WAIT_TIMEOUT {
                    members.valid = false;
                }
                break;
            }
            if message != JOB_OBJECT_MSG_NEW_PROCESS {
                continue;
            }
            members.observed = members.observed.saturating_add(1);
            if members.handles.len() >= 4096 {
                members.valid = false;
                continue;
            }
            // SAFETY: the event provides the PID; this opens only query/wait rights.
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    value as usize as u32,
                )
            };
            if handle.is_null() {
                // ERROR_INVALID_PARAMETER means the process identity is gone.
                if unsafe { GetLastError() } != ERROR_INVALID_PARAMETER {
                    members.valid = false;
                }
            } else {
                members.handles.push(handle as usize);
            }
        }
    }
    fn exited(&mut self) -> bool {
        use windows_sys::Win32::{
            Foundation::*,
            System::{JobObjects::*, Threading::*},
        };
        self.collect_members();
        let members = self.members.lock().unwrap();
        // SAFETY: the owned job handle remains open, and the writable structure
        // and its length match JobObjectBasicAccountingInformation exactly.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            );
            self.confirmed = ok != 0
                && members.valid
                && info.ActiveProcesses == 0
                && members.observed == info.TotalProcesses
                && members
                    .handles
                    .iter()
                    .all(|h| WaitForSingleObject(*h as HANDLE, 0) == WAIT_OBJECT_0);
        }
        self.confirmed
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.confirmed {
            self.terminate();
        }
        // SAFETY: closes the exclusively owned handle once.
        unsafe {
            for handle in &self.members.get_mut().unwrap().handles {
                windows_sys::Win32::Foundation::CloseHandle(*handle as _);
            }
            windows_sys::Win32::Foundation::CloseHandle(self.completion);
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}
