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

Rust owns imported assets. Frontend data contains opaque UUIDs, bounded display metadata and inspection evidence, not source paths. The custom `lvovd-media` protocol validates the exact protocol host, main-window identity, optional origin, asset ownership, methods and ranges. Responses are limited to 8 MiB, with at most four concurrent responders. Large reads require byte ranges; the native playback gate must demonstrate that supported webviews can seek using this interface. A full-file fallback must not allocate the entire source.

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

### Playback gate finding and design revision

The initial native proof is **not complete**. Windows WebView2 and both macOS architectures pass the generated video/audio playback and seeking scenarios. Ubuntu 22.04 with WebKitGTK 2.50.4 imports and inspects the MP4 successfully, but its media pipeline reports `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4), before metadata becomes available. The Rust protocol trace returns the requested `bytes=0-1445` as HTTP 206 with the correct length and total; changing the byte-range limit is not a demonstrated fix. Native CI deliberately keeps this failure visible. See [the evidence run](https://github.com/landonrivers/LVOVD/actions/runs/39090640086).

This matches the upstream [Linux custom-protocol media issue](https://github.com/tauri-apps/tauri/issues/3725). Tauri now has a separate [GStreamer asset plugin](https://github.com/tauri-apps/tauri-gstreamer-plugin), but its source maps asset URLs to filesystem paths. It is not a drop-in implementation of LVOVD's opaque-identity, revocation and read-lease boundary. This branch does not install that plugin or open a localhost server to bypass the failed gate.

Before 8B, revise the Linux transport as a narrowly scoped proof:

1. Prototype a GStreamer URI source for `lvovd-media` that asks the Rust owner for an authorized read through private local IPC. The media element should keep using opaque asset identities. A Unix-domain socket is a candidate; it is not an HTTP/TCP listener.
2. Require per-session authentication, bounded messages/reads and connection counts, deadlines, ownership validation, immediate revocation, and leases that survive until the decoder releases its stream. The helper must never translate frontend input into arbitrary paths. Verify WebKit's actual process/sandbox behavior before choosing the IPC mechanism.
3. Package/load only the reviewed application-owned helper, with pinned dependencies and license inventory. Audit plugin discovery so unrelated user/system overrides cannot replace it in distribution builds. This adds a Linux component to the maintenance scope.
4. Prove large-file playback, end-indexed MP4s, repeated seeks, audio, bounded memory, removal, decoder crashes, malicious identities and clean shutdown on the supported Linux baselines. Repeat the Windows/macOS gates unchanged.

This is a proposed transport revision, **not an implemented or proven remedy**. Do not start the larger backend migration, declare 8A complete, or weaken the no-server/all-platform release constraints until it passes. Merge, tagging and publication remain outside this implementation step.

### Remaining migration stages

1. **8A:** native foundation and cross-platform playback proof (this slice).
2. **8B:** v2.7 inspection/policy parity, plans, FFmpeg arguments, complete worker supervision, validation fixtures.
3. **8C:** workspaces, preview proxies, waveform limits/preemption, reservations, collections and processing.
4. **8D:** downloads, playlists, source coordination, failures, history and native output saving.
5. **8E:** compact branded interface, settings, single-instance/quit UX, history import and backend cutover.
6. **8F:** bundled runtime manifests/licenses, native packages, Evergreen bootstrap, signed app updates, portable rollback, maintenance automation and release acceptance.

v3.0 preserves all released workflows and audio precision/timing policies. Its interface remains JavaScript; the application backend becomes Rust. Node 24 remains only as yt-dlp's provider-script helper. Production has no localhost application server. A later development-only browser adapter may exercise the same Rust core.

Windows distribution uses Evergreen WebView2 with its offline installer, never a fixed runtime. Portable LVOVD needs no application installation but may offer one-time per-user Evergreen installation. macOS uses the system webview; Linux bundles and audits required playback libraries. Targets remain Windows 10/11 x64 installer/ZIP, macOS 13.5+ Intel/Apple Silicon DMGs, and Linux x64 AppImage on the accepted distro baselines.

Remembered destinations, collision-safe autosave, saved-export receipts, Open File/Show in Folder and Save Copy remain required. Persist settings/history, not live queues or editing sessions. Retain the accepted v2.6 poster-inspired compact design and 1280×720 / 960×640 layout gates. Optional startup app-update checks remain distinct from Microsoft's Evergreen update policy. Install app updates only after user action and safe shutdown; portable Windows updates need verification and rollback. Paid OS signing is optional, but cryptographic update signing is mandatory.

Roadmap #7 remains incomplete. Each stage is a separate reviewable PR. Merge, tagging and publication need separate authorization.
