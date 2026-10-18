//! Bounded external-tool execution. The caller retains admission until this returns.
use crate::{AppError, Result};
use std::{
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
pub use tokio_util::sync::CancellationToken;

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

pub async fn run(
    executable: &Path,
    args: &[OsString],
    deadline: Duration,
    limit: usize,
    cancel: &CancellationToken,
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
    let tree = match ProcessTree::attach(pid) {
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
                read_bounded(stdout, limit, &captured), read_bounded(stderr, limit, &captured),
                async { child.wait().await.map_err(|_| AppError::new("TOOL_EXIT", "Could not confirm tool exit.")) }
            )?;
            if !status.success() { return Err(AppError::new("TOOL_FAILED", "The tool rejected this operation.")); }
            Ok(Output { stdout, stderr })
        }) => result.unwrap_or_else(|_| Err(AppError::new("TOOL_TIMEOUT", "The tool exceeded its time limit.")))
    };
    // Also retire descendants that outlived a successful parent.
    tree.terminate();
    let _ = child.start_kill();
    child.wait().await.map_err(|_| {
        AppError::new(
            "TOOL_EXIT",
            "Could not confirm tool exit; resources remain owned.",
        )
    })?;
    result
}

#[cfg(unix)]
struct ProcessTree(u32);
#[cfg(unix)]
impl ProcessTree {
    fn attach(pid: u32) -> Result<Self> {
        Ok(Self(pid))
    }
    fn terminate(&self) {
        // SAFETY: the child created its own group before exec; the negative ID targets only that group.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
// SAFETY: this exclusively owned kernel handle is never accessed after Drop.
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn attach(pid: u32) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::*,
            System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
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
            let tree = Self(job);
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
        // SAFETY: this instance owns a live job handle; termination is idempotent.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
        // SAFETY: closes the exclusively owned handle once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
