# v3.0 desktop migration — 8A

The released product remains v2.7.0. The desktop preview is `3.0.0-alpha.1`, an independently versioned development application. It uses the Rust core and Tauri native commands; it does not start or fall back to the Node HTTP server. Do not distribute this as the completed v3.0 product. [The development contract](development-contract.md) governs product behavior and delivery; this document records the current stage and its evidence.

## Running the foundation

**Open the application, not an HTML file.** The desktop executable loads HTML/CSS/JavaScript inside its own window using the platform webview (Evergreen WebView2 on Windows). Opening `desktop/index.html` or `desktop/dist/index.html` in Chrome only displays the interface source; it cannot run the native backend. An HTML preview card is not a desktop build.

Install Rust using rustup and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```sh
npm ci
npm run build:desktop
```

On Windows, open **`target/debug/lvovd.exe`**. It starts directly in its own window without a batch file, terminal window, Node wrapper, or compilation step. Rebuild only when developing changes. `npm run dev:desktop` remains an optional compile-and-run command for developers.

| Entry point | What opens |
|---|---|
| `target/debug/lvovd.exe` | Built Windows desktop preview in its own application window |
| `npm run dev:desktop` | Rebuilds and runs the preview for development |
| `Start-LVOVD-Windows.bat` / `npm start` | v2.7 browser reference, accessed through localhost |
| `desktop/index.html` / `desktop/dist/index.html` | Interface assets only; not a runnable desktop app |

The old desktop batch launcher has been removed. The application binary is `lvovd` (`lvovd.exe` on Windows); the internal Cargo package name remains `lvovd-desktop`. A finished installer/portable package with bundled supporting tools is still stage 8F. Do not hand off an HTML file as the application.

The workspace pins its Rust toolchain and dependencies. In debug builds, Rust resolves tools at startup: explicit absolute `LVOVD_DESKTOP_FFPROBE`, `LVOVD_DESKTOP_FFMPEG`, `LVOVD_DESKTOP_YTDLP`, and `LVOVD_DESKTOP_NODE` overrides first, then bundled paths, the project-local yt-dlp cache, and installed tools on absolute PATH entries. Relative and empty PATH entries are ignored. Missing tools remain unavailable in Runtime details; the app does not silently download them. This development-only lookup lets the executable run without a wrapper or a particular working directory. Release builds exclude it and use only their resource-directory `tools` folder. Verified tool distribution remains a later gate.

`npm start` continues to run the released browser workflow during migration. The native preview deliberately has only file intake, bounded inspection, direct playback, removal/cleanup, runtime health, and coordinated close. Processing, waveform generation, provider downloads, proxies, output saving and application updates are not implemented in this slice. Unsupported direct playback says so rather than claiming a proxy exists.

The preview has a separate application identity and cache directory. Native selection/drop copies regular files into an owned temporary session, up to 20 files and 100 GiB aggregate. Removed files are revoked immediately; outstanding reads retain ownership until cleanup can succeed. Cleanup retry remains reachable. Original files are never deleted.

## Native boundary

The frontend adapter has no HTTP fallback. Protocol version 1 exposes a handshake, bounded runtime health, source snapshots, native selection, removal/retry, and shutdown. Each command is explicitly listed in the Tauri application permission manifest and granted only to the packaged main window. There are no frontend filesystem, shell, dialog-path, or arbitrary execution permissions.

Rust owns imported assets. Frontend data contains opaque UUIDs, bounded display metadata and inspection evidence, not source paths. The custom `lvovd-media` protocol validates the exact protocol host, main-window identity, optional origin, asset ownership, methods and ranges. Responses are limited to 8 MiB, with at most four concurrent responders and 32 admitted requests including waiters. Waiting is asynchronous and limited to five seconds; normal range bursts during file selection no longer receive an immediate 429 merely because the four readers are busy. Shutdown cancels queued requests and waits for active responders; ownership is checked again when a queued read begins. Large reads require byte ranges; the native playback gate must demonstrate that supported webviews can seek using this interface. A full-file fallback must not allocate the entire source.

The tool supervisor starts processes without a shell, with bounded stdout/stderr, explicit deadlines and cancellation. Windows workers start suspended, join a kill-on-close Job Object, then resume. Unix workers get a dedicated process group. Rust waits for the direct child after termination and retains the operation until that acknowledgement. Broader worker lifecycle and processing policy parity continue in 8B.

## Verification

```sh
npm run check
npm run test:media
npm run test:browser
npm run fmt:desktop
npm run check:desktop
npm run test:desktop:core
npm run test:desktop:host
node scripts/desktop.cjs build --features test-driver
npm run test:desktop:native
```

Native tests launch the binary from another working directory without the Node wrapper's tool-path overrides. They use generated media, real inspection, byte-range playback and repeated seeking in the actual platform webview, including large MP4s with their index at either end. They also check removal, original preservation, rejected privileged operations, and desktop/narrow layout. On headless Linux run under `xvfb-run -a dbus-run-session --` so desktop services inherit the virtual display; CI supplies software rendering because that display has no GPU. These are test-environment settings, not production defaults; packaged desktop/GPU acceptance remains required. CI includes Windows, Linux, and both macOS architectures. Do not advance the larger backend port until all native playback gates pass.

The optional WebdriverIO driver embeds a control server **only in explicitly enabled debug test builds**. Production rejects that feature at compile time. `LVOVD_DESKTOP_TEST_FILE` is accepted only in that test build to automate picker intake using generated fixtures; there is no frontend command accepting arbitrary paths. Normal builds have neither mechanism. Keep automation test binaries local/CI-only.

## Accepted delivery sequence

The migration integrates on `staging/v3-desktop`. PR #52 and later stage PRs target that branch; `master` remains the released v2.7 application. A successful stage is an intermediate development milestone. Promotion to `master`, tagging and publication require complete migration acceptance and separate authorization.

### Playback gate and Linux transport

The original Ubuntu 22.04/WebKitGTK 2.50.4 build imported and inspected MP4s but reported `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) before playback metadata. The Rust protocol returned the requested byte range correctly. The failure was in the native media transport, not the inspection or range-size policy; see [the original evidence](https://github.com/landonrivers/LVOVD/actions/runs/39090640086).

This matches the upstream [Linux custom-protocol media issue](https://github.com/tauri-apps/tauri/issues/3725). WebKit's GStreamer web source handles HTTP, HTTPS and blob URLs; a separate GStreamer source is needed for the application scheme. WebKit 2.50 also [validates media schemes before loading](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/platform/graphics/gstreamer/GStreamerCommon.cpp), so the host explicitly permits its owned scheme. Tauri's separate asset plugin maps URLs to filesystem paths, so it is not used for LVOVD's owned media.

The Linux transport uses the following ownership boundary:

1. `crates/lvovd-gstreamer` implements a seekable GStreamer source for `lvovd-media://localhost/<asset-id>`. It accepts only canonical version-4 UUIDs. Its private binary protocol carries an asset identity, offsets and lengths; it has no filename or arbitrary filesystem operation.
2. `crates/lvovd-core/src/playback.rs` owns the Unix socket broker. A private directory/socket, same-user peer credentials and a per-session secret protect admission. At most eight decoder connections each read at most 1 MiB per transaction. Greetings and transactions have three-second deadlines; idle connections expire after 30 seconds and must re-authorize to resume.
3. Rust retains a source lease for each admitted decoder. Removal revokes new reads and interrupts idle clients. Decoder exit releases its lease; cleanup failure remains owned and retryable. Shutdown waits for broker tasks and any blocking reads before deleting owned data. External media tools do not inherit the IPC secret.
4. Before starting GTK or worker threads, the host copies its adjacent, application-built helper into a private session, clears ambient GStreamer discovery overrides, selects that helper plus the build's system codec directory, and creates a fresh private registry. WebKit's media-scheme allowlist is extended with only `lvovd-media`, replacing any ambient extra-scheme list. WebKit's existing sandbox bindings for GStreamer plugin/registry paths provide access to the socket; the session contains no imported media. No sandbox-disabling flag or HTTP/TCP media listener is introduced.

The Linux helper is built by `npm run build:desktop` / `npm run dev:desktop` and placed next to the executable under `gstreamer/libgstlvovd.so`. Running a Linux build directly requires that adjacent helper. Install GStreamer core/base development headers in addition to the normal Tauri prerequisites. The Rust bindings are locked at 0.25.4; the application-owned helper uses this repository's Apache-2.0 license. System GStreamer and codec plugins remain development prerequisites. Stage 8F must include the helper, required playback libraries, their license/source obligations, and exact build/checksum inventory in the distribution.

Tests cover wrong credentials, invalid identities, malformed/oversized requests and replies, stalled peers, connection limits, revocation, crashed decoders, failed cleanup, and shutdown. Native tests exercise MP4/M4A playback, seeking near either end, selection changes, removal and layout. The same tests exposed a Windows range-read/removal race: after the last reader exited, eligible cleanup was not retried. The host now retries pending cleanup after a range response releases its lease and publishes the resulting snapshot; deletion failures remain retryable.

These are development-build tests using generated fixtures. Linux runs in a virtual display with software rendering, and playback is muted. Physical audio/GPU acceptance, common display scaling, clean-machine packages, and AppImage validation on Ubuntu 22.04/24.04 and Debian 12 remain required before release. No live providers were contacted by these tests.

**The 8A native playback gate passes on every development target.** The [native acceptance run for `eda52ed`](https://github.com/landonrivers/LVOVD/actions/runs/39149694688) exercises three generated-media scenarios on each platform:

| Target | Native playback, repeated seeks, selection/removal, permissions, shutdown and layout |
|---|---|
| Windows x64 / Evergreen WebView2 | Passed |
| Ubuntu 22.04 x64 / WebKitGTK 2.50.4 | Passed |
| macOS 15 / Apple Silicon system webview | Passed |
| macOS 15 / Intel system webview | Passed |

Rust formatting, Clippy, ownership/protocol/process tests and native launch-tool tests run in the same matrix. Each target is rebuilt without test controls afterward. The [Linux/Windows regression workflow](https://github.com/landonrivers/LVOVD/actions/runs/39149694712) retains `npm run check`, generated-media and Chromium checks for the released reference. Native desktop/narrow screenshots were inspected on Windows, Linux and macOS. The Windows cleanup fix also passed three consecutive local native runs before the normal `lvovd.exe` was rebuilt.

8A was merged through [PR #52](https://github.com/landonrivers/LVOVD/pull/52) into `staging/v3-desktop` at `5378771`, after the final staging-policy head `a359c31` passed [all native targets](https://github.com/landonrivers/LVOVD/actions/runs/39153683803) and [reference verification](https://github.com/landonrivers/LVOVD/actions/runs/39153698227). `master` remains on released v2.7.0. [8B was accepted through PR #53](desktop-media-policies.md) at staging merge `109cf635301dc8f28ae18cbffa5cf8fde41e14d0`. [8C Local Media integration](desktop-local-media.md) continues in its own draft PR; no migration promotion, tagging or publication is authorized.

### Remaining migration stages

1. **8A:** native foundation and cross-platform playback proof (this slice; native gate passed).
2. **8B:** v2.7 inspection/policy parity, plans, FFmpeg arguments, complete worker supervision, validation fixtures.
3. **8C:** workspaces, preview proxies, waveform limits/preemption, reservations, collections and processing.
4. **8D:** downloads, playlists, source coordination, failures, history and native output saving.
5. **8E:** compact branded interface, settings, single-instance/quit UX, history import and backend cutover.
6. **8F:** bundled runtime manifests/licenses, native packages, Evergreen bootstrap, signed app updates, portable rollback, maintenance automation and release acceptance.

v3.0 preserves all released workflows and audio precision/timing policies. Its interface remains JavaScript; the application backend becomes Rust. Node 24 remains only as yt-dlp's provider-script helper. Production has no localhost application server. A later development-only browser adapter may exercise the same Rust core.

Windows distribution uses Evergreen WebView2 with its offline installer, never a fixed runtime. Portable LVOVD needs no application installation but may offer one-time per-user Evergreen installation. macOS uses the system webview; Linux bundles and audits required playback libraries. Targets remain Windows 10/11 x64 installer/ZIP, macOS 13.5+ Intel/Apple Silicon DMGs, and Linux x64 AppImage on the accepted distro baselines.

Remembered destinations, collision-safe autosave, saved-export receipts, Open File/Show in Folder and Save Copy remain required. Persist settings/history, not live queues or editing sessions. Retain the accepted v2.6 poster-inspired compact design and 1280×720 / 960×640 layout gates. Optional startup app-update checks remain distinct from Microsoft's Evergreen update policy. Install app updates only after user action and safe shutdown; portable Windows updates need verification and rollback. Paid OS signing is optional, but cryptographic update signing is mandatory.

Roadmap #7 remains incomplete. Each stage is a separate reviewable PR. Merge, tagging and publication need separate authorization.
