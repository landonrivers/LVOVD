# LVOVD development contract

This contract records the accepted product and engineering commitments. It applies to human contributors and coding agents. [ROADMAP.md](../ROADMAP.md) tracks feature scope; [desktop-foundation.md](desktop-foundation.md) records current migration evidence; [CONTRIBUTING.md](../CONTRIBUTING.md) gives development and validation commands. Proposed remedies are not accepted facts or completed features.

## Product purpose and interface

LVOVD is a practical local media utility. Users should be able to identify the next action, understand what is happening, and recover from failures without knowing the implementation.

- Keep Download, Local Media, History, and Settings as the accepted desktop workflow structure. The small 8A playback preview is a temporary proof, not a replacement product design.
- Retain the released interface and interaction behavior while moving backend authority to Rust. Avoid gratuitous renaming, extra confirmation steps, or rebuilding controls without a functional reason.
- Keep primary actions, playback, editing controls, and the chosen destination reachable. Use bounded internal scrolling; validate desktop and narrow layouts, keyboard access, scaling, and contrast.
- Preserve the parchment, dark ink, berry red, leaf green, muted gold visual direction with restrained decoration away from media and precision controls. Light mode remains deferred.
- Use concise, literal interface copy. Help must explain a decision, a consequence, a state, or recovery. Errors should describe what failed and the available next action without claiming an unknown cause.
- Do not insert promotional slogans, filler sentences, repeated local/privacy claims, technical stack announcements, or roadmap explanations into the application. Branding belongs in the identity; architecture and migration discussion belong in documentation. Runtime diagnostics can expose technical facts when useful for troubleshooting.
- Show one brief scope notice in an incomplete preview. Do not display working-looking controls for unimplemented operations or claim release readiness.

## Desktop architecture and delivery

- v3.0 is a standalone Tauri 2 application with a Rust backend and an HTML/CSS/JavaScript interface. On Windows the interface is rendered by Evergreen WebView2 inside the application's own window. HTML is an internal UI asset, not the launch target.
- Production has no localhost HTTP application server. Native commands and channels carry operations and progress; an application-owned media transport carries bounded reads by opaque asset identity.
- Rust owns jobs, collections, assets, reservations, policies, plans, and output leases. JavaScript owns presentation and uncommitted editing drafts. Validate requests in Rust independently of frontend validation.
- FFmpeg, FFprobe, and yt-dlp remain supervised external tools. Bundled Node 24 is only a yt-dlp provider-script helper in the finished product, not the LVOVD backend.
- During migration, the v2.7 Node/browser application remains a development reference. Label its instructions separately. At cutover, `npm start` becomes a development-only harness over the same Rust core; the old backend is excluded from production packaging.
- The Windows application is named `lvovd.exe` and launches directly without a batch file or a build step. The executable owns application startup and tool discovery. Build commands are for development, not normal use.
- A desktop handoff must identify the executable. Do not link an `index.html` file or open a browser tab and call that desktop acceptance. Verify a native window/process and report missing functionality honestly.
- End users of the finished distribution need no Node, Rust, FFmpeg, or Python setup. Supporting tools can be separate files in the application package; LVOVD launches them as needed. Development builds may use locally installed tools until packaging is implemented, and must say so.

## Behavior that must survive the rewrite

- Preserve reviewed plan version 1, normalization, rounding, immutable queued settings, shared settings with individual cuts, and actionable failures.
- Preserve serialized source acquisition, 0.5–1-second playlist pauses, stop-on-rejection behavior, and the existing collection, job, and storage limits.
- Preserve original-file no-ops, exact retained ranges, audio clocks/gaps, strict FLAC precision rules, channel-layout restrictions, Opus behavior, and maximum-size processing.
- Unknown metadata stays unknown. Preview establishes source compatibility; never promise that every provider or file works.
- Final processing reads the authoritative source. Proxy or waveform failures must leave editing and processing available where supported.
- Keep waveform limits: one decode, a 120-second deadline, duration-derived decoded-byte ceiling, at most 200,000 peak pairs, bins no finer than 10 ms, and at most 4,096 returned pairs. Foreground processing preempts analysis and waits for child exit.
- Revocation prevents new access immediately. Reservations and cleanup ownership remain until workers/readers exit and deletion succeeds. Late responses cannot restore removed entries or replace another selection's state.
- Never delete user originals or exported files as workspace/history cleanup. Native export saves are collision-safe, distinguish processing/saving/saved/failure, and permit save retries without reprocessing. Queued work captures its destination and filename.
- Persist settings, terminal history, and the export catalog; do not restore editing sessions or queues. Keep legacy history import honest about unknown saved paths.

## Security and maintenance

Follow [SECURITY.md](../SECURITY.md). In particular:

- Load packaged UI assets in the privileged window, explicitly allow the needed native commands, restrict CSP/navigation, and treat media/provider metadata as untrusted text. Do not add broad shell/filesystem permissions.
- Use explicit executable paths and argument arrays without a shell, bounded output and deadlines, controlled tool configuration, and cancellation that confirms termination before releasing resources.
- Authorize media reads by identity and ownership with bounded range reads and leases. Do not expose arbitrary paths or buffer an entire large file to work around playback failures.
- Preserve local-input restrictions. Rust's memory safety does not make external decoders invulnerable.
- Keep user data separate from immutable installation resources. Normal application use must not require administrator rights. Add no telemetry.
- Retain the browser reference's loopback security checks during migration. Do not expose it to a network to solve a desktop problem.
- Keep dependencies pinned, tools verified, and test drivers/developer control servers out of distributed binaries. Before stable release, complete advisory/license checks, component inventories, dependency/security workflows, and release triage.
- Use Evergreen only on Windows; keep application updates separate from webview updates and never restart active work merely to adopt an update. Application installation requires user action and verified signatures; portable updates require safe staging and rollback.
- Keep authenticated-session support, parallel remote acquisition, and access-control bypass behavior outside scope. Preserve public source-example hygiene and attribution.

## Migration gates and review

Deliver separate reviewable stages: 8A foundation/playback, 8B policy/tool parity, 8C Local Media, 8D Download/history/saving, 8E desktop experience/cutover, and 8F distribution/maintenance.

8A must prove media playback in actual Windows, macOS, and Linux webviews before the larger backend port. A failing platform requires an explicit finding and design revision, not an HTTP fallback or a skipped test. Record current results and their limits in the stage document, and keep every platform gate required during later stages.

Stable v3.0 requires released v2.7 workflow parity and all launch targets: Windows 10/11 x64 installer/portable ZIP; macOS 13.5+ Intel and Apple Silicon DMGs; Linux x64 AppImage validated on Ubuntu 22.04/24.04 and Debian 12. Packaging, bundled tools/licenses, optional signed updates, native saving, persistence, quit handling, and security maintenance remain required. Paid OS signing is not a prerequisite; describe trust prompts without recommending disabled protections.

Keep Roadmap #7 explicitly incomplete. New video codecs, hardware encoding, images, richer track selection, persistent editing projects, automatic queue recovery, light mode, native GUI replacement, and tray behavior remain deferred. A change to these commitments requires an explicit product decision, not an incidental implementation shortcut.

Report what changed, why, actual validation, and remaining limitations. Reviewable PR preparation does not authorize merge, tagging, or publication.
