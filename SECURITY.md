# Security Policy

LVOVD processes media locally. The released v2.7 browser application uses a Node server bound to `127.0.0.1` unless the user deliberately changes that configuration. The v3.0 desktop preview uses restricted native commands and owned media access without a localhost application server; see [Desktop preview and maintenance](#desktop-preview-and-maintenance). The [development contract](docs/development-contract.md) keeps these execution paths distinct during migration.

## Reporting a vulnerability

Please **do not open a public issue for a security vulnerability**.

When this repository is public, use GitHub's **Private vulnerability reporting** feature if it is enabled for the repository. Include enough detail to reproduce the problem, the affected LVOVD version or commit, and the impact you believe it has.

If private vulnerability reporting is not available, contact the repository owner privately through an appropriate GitHub contact method rather than posting exploit details publicly.

## What counts as a security issue

Examples include:

- a remote webpage being able to make LVOVD perform unintended local actions;
- bypasses of the localhost Host/Origin/Fetch-Metadata checks;
- command or argument injection into yt-dlp, FFmpeg, Node, or the operating system;
- unintended exposure of local files, browser sessions, cookies, credentials, or downloaded media;
- directory traversal or arbitrary file reads/writes;
- unsafe behavior caused by exposing LVOVD beyond localhost;
- dependency or supply-chain vulnerabilities that materially affect LVOVD users.

## Browser reference security model

By default LVOVD listens on `127.0.0.1`. The public-facing browser UI and the Node server are on the same computer.

The server applies additional request checks for:

- expected `Host` values;
- same-origin / directly-entered browser requests using Fetch Metadata;
- expected `Origin` values when an Origin header is present;
- anti-framing and browser security headers.

These controls are defense in depth. They are not a promise that LVOVD is safe to expose directly to the public Internet.

If you deliberately bind LVOVD to a LAN or wildcard address, you are changing its security model. Use `LVOVD_ALLOWED_HOSTS` to explicitly list hostnames that should be accepted and put appropriate authentication/reverse-proxy protections in front of the application if other people can reach it.

## yt-dlp binary supply chain

LVOVD does not depend on a third-party Node wrapper to install or invoke yt-dlp. The project has no third-party Node runtime dependencies.

On first use, LVOVD downloads the platform-appropriate standalone binary from the official yt-dlp GitHub release infrastructure. It also downloads that same release's `SHA2-256SUMS`, requires the requested binary to be present in the checksum list, computes SHA-256 locally, and installs the binary only when the hashes match. Redirects are restricted to HTTPS and expected GitHub release-asset hosts, downloads are size-limited, and replacement is performed through a temporary file so a failed update does not intentionally replace a known-good binary.

The verified executable and a small checksum manifest are cached in `.lvovd-bin/`. Every startup verifies the cached executable against its saved SHA-256 value. LVOVD also records when it last checked the selected yt-dlp release channel for freshness. Once that check is at least 24 hours old, startup queries the official GitHub release metadata; an unchanged release reuses the current binary, while a newer release is downloaded, verified, and installed atomically. If the freshness request fails but the cached executable still passes local integrity verification, LVOVD keeps using that verified cached copy rather than making GitHub availability a requirement for startup.

This checksum validation detects corruption and mismatched release assets, but it is not an independent chain of trust: both the executable and published checksum ultimately come from GitHub/yt-dlp release infrastructure. A user-supplied `YTDLP_PATH` override is outside LVOVD's managed verification because LVOVD cannot know which custom build the user intended.

## Local media input and cleanup boundaries

Workspace FFprobe/FFmpeg inputs use a fixed demuxer allowlist before header/deep inspection, a `file`-only protocol policy, and disabled MOV external-track/absolute-path options. A file-protocol restriction by itself is **not** filesystem containment. The demuxer policy excludes dependency-resolving playlist/reference readers; no manifest resolver is provided. FFmpeg processing pins the demuxer identified by protected inspection. The same policy applies to local uploads, the final locally adopted URL-acquired source, proxies, edited rendering, and output-validation probes. Remote yt-dlp acquisition is separate and may still acquire HLS/DASH normally.

The allowed demuxers are `mov` (MP4/MOV family), `matroska` (Matroska/WebM), `avi`, `asf`, `flv`, `mpeg`, `mpegts`, `ogg`, `nut`, `mp3`, `aac`, `flac`, `wav`, `aiff`, `amr`, `ape`, `wv`, `tta`, `ac3`, `eac3`, `dts`, `au`, and `caf`. This is a conservative container-input boundary, not a codec whitelist or a promise that every file in those containers can be edited. Audio-only files and attached cover art remain ineligible for the video editor. Other containers are rejected even if a particular file happens to be self-contained.

These arguments rely on the installed FFmpeg/FFprobe implementing their documented options. They are not a general OS/process sandbox and do not protect against every possible media-decoder defect. Unsupported tool options fail closed. Keep the locally installed tools up to date. The upstream [format policy](https://ffmpeg.org/ffmpeg-formats.html#Format-Options) and [MOV external-track options](https://ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp) document the relevant controls.

Workspace Discard invalidates the registry and progress/media/output access before waiting for physical deletion. Owned readers are closed and active operations cancelled before deletion. Pending directories and their assets remain in process-owned cleanup records until removal succeeds. Transient `EBUSY`, `EPERM`, `ENOTEMPTY`, `EMFILE`, or `ENFILE` failures receive two retries (100 ms and 500 ms); other failures stop immediately. Exhausted records remain owned without endless automatic retries. A repeat DELETE for that opaque discarded workspace ID can explicitly retry its retained cleanup; it cannot restore media access. Responses distinguish `complete`, `pending`, and `failed` cleanup without returning local paths. This is in-memory bookkeeping only: abrupt termination can still leave temporary bytes behind, as documented in the README.

All application-controlled yt-dlp source operations use `--ignore-config`; LVOVD does not supply external configuration locations. This isolates option files, not executable/plugin code. Default extractor plugins and an explicit `YTDLP_PATH` are still trusted local code chosen by the user.

## Local history data

LVOVD can keep a small durable download-history file in the current user's local application-data directory. History is local metadata, not a second copy of downloaded media and not telemetry.

A history record can contain the source page URL (and selected playlist-item page URLs), the normalized download choices, bounded display title/source name, output filename/type/size metadata, terminal status, and failure details. Source URLs and titles can themselves be sensitive, so anyone with access to the user's local application-data files may be able to read this history.

History deliberately does **not** persist:

- LVOVD temporary workspace paths;
- the browser's final download/save path, which LVOVD does not know;
- yt-dlp internal media/CDN URLs or format URLs;
- Preview thumbnail URLs;
- active child-process, progress, or EventSource state.

History read/write failures are isolated from the downloader. A corrupt or inaccessible history file may make the history API unavailable, but it must not prevent normal Preview/download operation or turn a successful media job into a failed one. Deleting a history record deletes only the metadata record; it does not delete files the browser saved elsewhere.

## Secrets and session data

Do not commit `.env` files, npm credentials, exported browser cookies, HAR captures, private keys, or other session material. The repository `.gitignore` includes common patterns as a safety net, but contributors are still responsible for reviewing what they commit.

## Responsible use

Security reports should focus on LVOVD itself. LVOVD is not intended to bypass DRM, authentication, paywalls, or other access controls, and reports requesting such bypasses are outside the project's intended scope.

## Desktop preview and maintenance

Report suspected vulnerabilities privately through the repository's GitHub security reporting facility when enabled; otherwise contact the maintainer privately before sharing exploit details. Do not include private media, cookies, credentials or source-provider URLs in public reports.

The v2.7 browser release and the v3.0 desktop development preview are different execution paths. Desktop Rust code runs with the user's OS privileges; Tauri permissions constrain the interface, not a compromised native tool. External media and provider metadata are untrusted. No administrator privileges are required for normal application use.

The desktop preview loads packaged scripts, denies external navigation, exposes only declared native operations, and reads media through opaque owned identities. It does not listen on a localhost application port. Test drivers are opt-in debug-only dependencies and must never be distributed. Native commands must validate ownership, limits, revisions and all fields independently of UI validation.

The 8B unified processing core resolves owned original identities and produces private, single-use admission tickets. It allocates output paths itself and publishes only after supervised worker exit, bounded inspection, media/size validation and a current-source/current-operation check. Replacement revokes new result lookup while existing read leases retain bytes; failed attempts and cleanup never replace a previous successful result. File identity, modification, link and Windows reparse-point checks detect changed owned files, but do not sandbox a hostile process running as the same user. Native processing commands are still an 8C integration task and must use this ownership boundary; a frontend review or inspection document is not execution/publication authority.

Finished v3.0 must retain custom yt-dlp executables and extractor plugins through explicit native selection/import; this management remains unimplemented in the current preview. Bundled verified tools are the default. Rust must disable ambient configuration/plugin discovery, record approved content fingerprints, stage explicitly imported packages in owned storage, reject unsafe archive paths/links, never execute installation hooks, and capture approved versions for active jobs. Changed executable/plugin content requires renewed trust approval; third-party plugins are not silently updated. Custom code is user-trusted, not verified official code. Plugins can override built-in extractors and execute with the user's privileges; process supervision and hashes are not a sandbox or proof of safety. Additional custom dependencies must be reported rather than silently installed. See the [development contract](docs/development-contract.md#required-yt-dlp-and-plugin-support) and [parity register](docs/v3-feature-parity.md).

On Linux, an application-owned GStreamer source reads through a private Unix socket. Requests contain authenticated asset identities and bounded byte ranges, never paths. Rust enforces ownership, revocation, eight connection slots and 1 MiB read limits, and retains leases until reads finish. The decoder validates reply lengths before allocating. Three-second transaction deadlines and a 30-second idle deadline bound stalled peers; removal and shutdown cancel active sessions. FFmpeg, FFprobe and provider helpers do not inherit the IPC secret.

The Linux host establishes an explicit helper/system-codec search path and a fresh private registry before starting GTK threads. It clears ambient GStreamer discovery overrides and permits only `lvovd-media` as an additional WebKit media scheme, replacing any ambient extra-scheme list. WebKit's GStreamer sandbox mounts provide access to the private socket directory, which contains no imported media. This does not make GStreamer or its codec libraries immune to decoder vulnerabilities. The helper and every playback library included in final Linux packages require version, license/source, checksum and advisory tracking in stage 8F.

Before stable v3.0, delivery must include dependency-update PRs, weekly advisory scans, Cargo advisory/license checks, shipped-component inventories, current/upcoming Evergreen compatibility tests and a documented release-maintenance checklist. These scheduled workflows are not yet enabled by the 8A foundation. Relevant critical/high advisories block stable release until resolved or documented as non-applicable. Security fixes can ship independently of feature milestones.

Evergreen WebView2 normally updates through Microsoft and requires application restart to adopt a new runtime. Respect administrator policy and never interrupt work to force a restart. macOS system-webview updates are an OS responsibility. Every WebKit/GStreamer component actually bundled on Linux, and every bundled tool or compiled Rust/Tauri dependency, is a project maintenance responsibility. Rust does not make FFmpeg or provider helpers immune to vulnerabilities.

Release/update keys belong only in protected release secrets, never this repository. Updates require signature verification and safe shutdown. OS publisher signing and update-artifact signing are separate; free distribution does not remove the update-signature requirement.
