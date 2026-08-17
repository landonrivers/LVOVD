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

## Secrets and session data

Do not commit `.env` files, npm credentials, exported browser cookies, HAR captures, private keys, or other session material. The repository `.gitignore` includes common patterns as a safety net, but contributors are still responsible for reviewing what they commit.

## Responsible use

Security reports should focus on LVOVD itself. LVOVD is not intended to bypass DRM, authentication, paywalls, or other access controls, and reports requesting such bypasses are outside the project's intended scope.
