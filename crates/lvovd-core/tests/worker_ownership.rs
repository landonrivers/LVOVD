use lvovd_core::process::{CancellationToken, Supervisor};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
fn node() -> PathBuf {
    std::env::var_os("LVOVD_DESKTOP_NODE").unwrap().into()
}
struct Identity {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    handle: usize,
}
impl Identity {
    fn new(pid: u32) -> Self {
        #[cfg(unix)]
        {
            Self { pid }
        }
        #[cfg(windows)]
        // SAFETY: retains a checked process handle, preventing PID reuse from
        // making a later liveness check observe an unrelated process.
        unsafe {
            use windows_sys::Win32::System::Threading::*;
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            assert!(!handle.is_null());
            Self {
                handle: handle as usize,
            }
        }
    }
    fn alive(&self) -> bool {
        #[cfg(unix)]
        // SAFETY: zero only queries the synthetic descendant's process identity.
        unsafe {
            libc::kill(self.pid as i32, 0) == 0
        }
        #[cfg(windows)]
        // SAFETY: handle validity is checked, queried without mutation, then closed.
        unsafe {
            use windows_sys::Win32::{Foundation::*, System::Threading::*};
            WaitForSingleObject(self.handle as HANDLE, 0) == WAIT_TIMEOUT
        }
    }
}
#[cfg(windows)]
impl Drop for Identity {
    fn drop(&mut self) {
        // SAFETY: this object exclusively owns its checked kernel handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}
struct Ownership {
    identity: Arc<Mutex<Option<Arc<Identity>>>>,
    released: Arc<AtomicBool>,
    premature: Arc<AtomicBool>,
}
impl Drop for Ownership {
    fn drop(&mut self) {
        if let Some(identity) = self.identity.lock().unwrap().as_ref() {
            self.premature.store(identity.alive(), Ordering::SeqCst);
        }
        self.released.store(true, Ordering::SeqCst);
    }
}
async fn ready(path: &Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(path).await
                && let Ok(pid) = text.parse()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn args(path: &Path, mode: &str) -> Vec<OsString> {
    let child = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
    let marker = serde_json::to_string(path.to_str().unwrap()).unwrap();
    let gate = serde_json::to_string(path.with_extension("gate").to_str().unwrap()).unwrap();
    let child = serde_json::to_string(child).unwrap();
    let terminal = match mode {
        "success" => "process.stdout.write('ok');process.exit(0)",
        "failure" => "process.exit(3)",
        "limit" => "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",
        _ => "setInterval(()=>{},1000)",
    };
    let script = format!(
        "const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',{child},{marker}],{{stdio:'inherit',windowsHide:true}});child.unref();const wait=setInterval(()=>{{if(fs.existsSync({marker})&&fs.existsSync({gate})){{clearInterval(wait);{terminal};}}}},10);"
    );
    vec!["-e".into(), script.into()]
}
#[tokio::test]
async fn every_exit_path_confirms_descendants_before_releasing_ownership() {
    for (mode, streaming) in [
        "success",
        "failure",
        "limit",
        "timeout",
        "cancel",
        "abort-waiter",
        "shutdown",
    ]
    .into_iter()
    .flat_map(|mode| [(mode, false), (mode, true)])
    {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("child.pid");
        let released = Arc::new(AtomicBool::new(false));
        let premature = Arc::new(AtomicBool::new(false));
        let identity = Arc::new(Mutex::new(None));
        let owner = Ownership {
            identity: identity.clone(),
            released: released.clone(),
            premature: premature.clone(),
        };
        let supervisor = Arc::new(Supervisor::default());
        let cancel = CancellationToken::new();
        let worker_cancel = cancel.clone();
        let worker = supervisor.clone();
        let arguments = args(&marker, mode);
        let task = tokio::spawn(async move {
            if streaming {
                let mut bytes = 0;
                worker
                    .run_stream_owned(
                        lvovd_core::process::Request {
                            executable: &node(),
                            args: &arguments,
                            deadline: Duration::from_secs(if mode == "timeout" { 5 } else { 30 }),
                            diagnostic_limit: 1024,
                            cancel: &worker_cancel,
                        },
                        move |chunk| {
                            assert!(chunk.len() <= 8192);
                            bytes += chunk.len();
                            if bytes > 1024 {
                                Err(lvovd_core::AppError::new(
                                    "TOOL_OUTPUT_LIMIT",
                                    "Synthetic decoded-byte ceiling",
                                ))
                            } else {
                                Ok(())
                            }
                        },
                        owner,
                    )
                    .await
            } else {
                worker
                    .run_owned(
                        &node(),
                        &arguments,
                        Duration::from_secs(if mode == "timeout" { 5 } else { 30 }),
                        1024,
                        &worker_cancel,
                        owner,
                    )
                    .await
            }
        });
        let pid = ready(&marker).await;
        let child = Arc::new(Identity::new(pid));
        *identity.lock().unwrap() = Some(child.clone());
        std::fs::write(marker.with_extension("gate"), b"continue").unwrap();
        match mode {
            "cancel" => cancel.cancel(),
            "abort-waiter" => task.abort(),
            "shutdown" => supervisor.shutdown().await.unwrap(),
            _ => {}
        }
        if mode != "abort-waiter" {
            let result = tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .unwrap()
                .unwrap();
            let expected = match mode {
                "failure" => Some("TOOL_FAILED"),
                "limit" => Some("TOOL_OUTPUT_LIMIT"),
                "timeout" => Some("TOOL_TIMEOUT"),
                "cancel" | "shutdown" => Some("CANCELLED"),
                _ => None,
            };
            match expected {
                Some(code) => assert_eq!(result.unwrap_err().code, code, "{mode}"),
                None => assert_eq!(
                    result.unwrap().stdout,
                    if streaming { b"".as_slice() } else { b"ok" }
                ),
            }
        }
        supervisor.shutdown().await.unwrap();
        assert!(released.load(Ordering::SeqCst), "{mode}");
        assert!(
            !premature.load(Ordering::SeqCst),
            "ownership released while descendant active: {mode}"
        );
        assert!(!child.alive(), "{mode}");
        assert_eq!(
            supervisor
                .run_owned(&node(), &[], Duration::from_secs(1), 1024, &cancel, ())
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
    }
}

#[tokio::test]
async fn processing_progress_is_streamed_and_malformed_lines_stay_bounded() {
    use lvovd_core::process::{Progress, Request};
    let supervisor = Supervisor::default();
    let cancel = CancellationToken::new();
    let (send, receive) = tokio::sync::watch::channel(Progress::default());
    let arguments:Vec<OsString>=vec!["-e".into(),"for(let i=0;i<20000;i++)process.stdout.write('out_time_us='+i+'\\r\\n');process.stdout.write('out_time_us=invalid\\nout_time_us=-1\\n');process.stderr.write('bounded diagnostic')".into()];
    let output = supervisor
        .run_processing_owned(
            Request {
                executable: &node(),
                args: &arguments,
                deadline: Duration::from_secs(5),
                diagnostic_limit: 1024,
                cancel: &cancel,
            },
            send,
            (),
        )
        .await
        .unwrap();
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"bounded diagnostic");
    assert_eq!(receive.borrow().out_time_us, Some(19999));
    let (send, _) = tokio::sync::watch::channel(Progress::default());
    let arguments: Vec<OsString> = vec![
        "-e".into(),
        "process.stdout.write('x'.repeat(8193));setInterval(()=>{},1000)".into(),
    ];
    assert_eq!(
        supervisor
            .run_processing_owned(
                Request {
                    executable: &node(),
                    args: &arguments,
                    deadline: Duration::from_secs(5),
                    diagnostic_limit: 1024,
                    cancel: &cancel
                },
                send,
                ()
            )
            .await
            .unwrap_err()
            .code,
        "TOOL_OUTPUT_LIMIT"
    );
    supervisor.shutdown().await.unwrap();
}
