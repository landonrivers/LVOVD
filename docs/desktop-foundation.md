# v3.0 desktop migration — 8A

The released product remains v2.7.0. The desktop preview is `3.0.0-alpha.1`, an independently versioned development application. It uses the Rust core and Tauri native commands; it does not start or fall back to the Node HTTP server. Do not distribute this as the completed v3.0 product.

## Running the foundation

Install Rust using rustup and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```sh
npm ci
npm run dev:desktop
```

The workspace pins its Rust toolchain and dependencies. Development resolves existing FFmpeg/FFprobe and Node into explicit absolute paths; a previously downloaded project yt-dlp is also recognized. `LVOVD_DESKTOP_FFPROBE`, `LVOVD_DESKTOP_FFMPEG`, `LVOVD_DESKTOP_YTDLP`, and `LVOVD_DESKTOP_NODE` can override development paths. Release builds ignore those overrides and use their resource-directory `tools` folder. Distribution of those tools is a later gate, not an implicit PATH fallback.

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
node scripts/desktop.cjs build --features test-driver
npm run test:desktop:native
```

Native tests use generated media, real inspection, byte-range playback and repeated seeking in the actual platform webview. They also check removal, original preservation, rejected privileged operations, and narrow-window layout. On Linux run the native test under `xvfb-run -a`. CI includes Windows, Linux, and both macOS architectures. Do not advance the larger backend port until all native playback gates pass.

The optional WebdriverIO driver embeds a control server **only in explicitly enabled debug test builds**. Production rejects that feature at compile time. `LVOVD_DESKTOP_TEST_FILE` is accepted only in that test build to automate picker intake using generated fixtures; there is no frontend command accepting arbitrary paths. Normal builds have neither mechanism. Keep automation test binaries local/CI-only.

## Accepted delivery sequence

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
