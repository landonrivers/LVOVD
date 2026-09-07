# Security Policy

LVOVD is a local-first application. Its normal security boundary assumes the Node server is running only on the user's own computer and is bound to `127.0.0.1` unless the user deliberately changes that configuration.

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

## Local security model

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
