# LVOVD  
## Landon's Very Own Video Downloader

***"A Locally Hosted Video Downloader Which You'll Use Responsibly"***  
You're here because you don't trust any of those browser extensions or sketchy sites right? Well I'm sure you have the good sense to trust yourself, right? *Oh you don't*? Well allow me to further your plight. Anywho, here's some **SLOP** that I made.

![LVOVD in use](example.png)  

LVOVD is a local browser UI for **yt-dlp + FFmpeg**. Paste a media URL, preview what the source exposes, choose your download options, and **let your own computer do the work**.

> Use LVOVD only for media you own, public-domain material, or content you otherwise have permission to download. Respect the source service's terms and applicable copyright law.

## Table of Contents

- [Quick Start](#quick-start)
- [What it can do](#what-it-can-do)
- [Source compatibility](#source-compatibility)
- [Download options](#download-options)
- [Privacy and networking](#privacy-and-networking)
- [Authentication and cookies](#authentication-and-cookies)
- [Temporary files](#temporary-files)
- [Download history](#download-history)
- [yt-dlp binary management](#yt-dlp-binary-management)
- [Manual start](#manual-start)
- [Development](#development)
- [AI-generated project](#ai-generated-project)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Quick Start

### 1. Install Node.js 22+ and FFmpeg

If you already have both, skip this step.

**Windows 10/11**

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg.Essentials -e
```

Close and reopen your terminal after installation.

**macOS — Homebrew recommended**

Homebrew is the simplest way to install both requirements. If you do not already have Homebrew, install it from https://brew.sh/, then run:

```bash
brew install node ffmpeg
```

You can use Node.js's normal macOS installer instead if you prefer, but Homebrew is still the easiest path for FFmpeg.

**Linux — Debian/Ubuntu example**

The first command adds NodeSource's Node.js 24 LTS package repository. The second installs Node.js and FFmpeg:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash
sudo apt install -y nodejs ffmpeg
```

Other Linux distributions can install **Node.js 22+** and **FFmpeg** with their normal package manager. LVOVD does not require nvm or any particular Node installer.

**Check to see if everything is installed correctly:**

In a terminal, see that these return without errors:

```bash
node --version
ffmpeg -version
```

### 2. Get LVOVD

**Easy:** [Download the project as a ZIP](https://github.com/landonrivers/LVOVD/archive/refs/heads/master.zip) and extract it.

**Or with Git:**

```bash
git clone https://github.com/landonrivers/LVOVD.git
cd LVOVD
```

The benefit of git is that you'll always have access to the most up-to-date release.
For beginners, I recommend GitHub Desktop as an easy way to clone, manage, and update this project:  
*Github Desktop:* https://desktop.github.com/download/

### 3. Start LVOVD

- **Windows:** double-click `Start-LVOVD-Windows.bat`
- **macOS:** double-click `Start-LVOVD-Mac.command`
- **Linux:** run `./Start-LVOVD-Linux.sh`

On the first run, LVOVD downloads the appropriate **official yt-dlp standalone binary** from the yt-dlp project's GitHub release, verifies it against that release's published SHA-256 checksum, and stores it under the local `.lvovd-bin` folder. Later starts always verify the cached file locally. At most once every 24 hours, LVOVD also checks whether a newer release exists; it downloads a replacement only when one is available. Keep the launcher terminal open while using LVOVD.

### 4. Open LVOVD

Once the server is ready, the launcher prints both local addresses in the terminal. Click one if your terminal supports clickable links, or copy/paste it into your browser:

```text
http://127.0.0.1:3000
http://localhost:3000
```

## What it can do

- Download **Video + Audio**, **Video Only**, **Audio Only**, or **Extras Only**.
- Prefer editor-friendly **H.264/AAC MP4** when the source provides it, or choose **Maximum Quality** to preserve the best available source streams.
- Export audio as **Source Audio, M4A/AAC, MP3, Opus, FLAC, or WAV**. Converted formats are created locally with FFmpeg after source audio is downloaded.
- Choose a maximum resolution, custom time range, or detected chapters.
- Download thumbnails, metadata JSON, creator subtitles, and automatic captions when available.
- Preview playlists/collections and choose individual entries.
- Optionally use yt-dlp's SponsorBlock integration to mark or remove supported segment categories.
- Show real yt-dlp download progress, speed, ETA, and processing stages.

## Source compatibility

LVOVD does not contain separate downloader code for YouTube, Vimeo, TikTok, Facebook, Instagram, and every other service. It passes the URL to **yt-dlp**, then builds the UI from the metadata and formats yt-dlp returns.

**Preview is the compatibility check.** If yt-dlp can inspect the URL, LVOVD uses that result to decide which controls make sense for that source.

A site appearing in yt-dlp's supported-sites list does **not** guarantee every URL will always work. Extractors and source websites change, and some content requires authentication, browser cookies, or other access that LVOVD does not currently provide.

Current yt-dlp supported sites:
https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md

LVOVD does **not** bypass DRM, region restrictions, logins, or access controls.

## Download options

### Video

**Compatible MP4** prefers native H.264 video and AAC audio when available. This is usually the best choice for video editors.

**Maximum Quality** keeps the best qualifying source streams and may use codecs such as VP9, AV1, or Opus that some editors cannot decode even inside an `.mp4` container.

Video-only mode follows the same idea but produces no audio track.

### Audio

**Source Audio** keeps the best available source audio unchanged.

Choosing MP3, M4A/AAC, Opus, FLAC, or WAV still downloads source audio first, then converts the local file with FFmpeg. The selected output format does not change remote media acquisition.

### Extras, ranges, chapters, and subtitles

Where the source exposes them, LVOVD can download thumbnails, metadata JSON, subtitles/automatic captions, custom time ranges, and detected chapters. Chapter and custom-range selection are limited to single-media downloads because timing metadata differs between playlist items.

SponsorBlock is optional and off by default.

## Privacy and networking

LVOVD is **local-first, not anonymous**.

Your browser connects to LVOVD on `127.0.0.1`. The browser displays the interface and receives the finished local file; **Node/yt-dlp running on your computer makes the Preview and media-acquisition requests to the source website**.

```text
Your browser
    ↓ localhost
LVOVD on your computer
    ↓
yt-dlp / FFmpeg
    ↓
Source website / media CDN
```

Preview artwork is a separate browser behavior: when yt-dlp (or a plugin) reports a thumbnail URL, LVOVD embeds that URL at runtime. The browser may therefore fetch the thumbnail directly from that source/CDN using its normal networking, cookie, and cache behavior. LVOVD does not proxy, persist, rehost, or add that Preview thumbnail to its download history.

There is no hosted LVOVD backend, account system, analytics service, advertising service, or cloud database. Downloaded media is not uploaded to ChatGPT or OpenAI by LVOVD.

The source website still sees normal network requests from your connection, including information such as your public IP address. Your browser may also keep normal local history/download information depending on its own settings and extensions.

**Preview also contacts the source:** it is LVOVD's compatibility/capability probe, not a local-only lookup. Download jobs are serialized so LVOVD does not run multiple remote acquisitions at once, and selected playlist items get a short randomized pause between them. If a source reports a request limit or rejects a download, LVOVD stops instead of automatically retrying through the batch. These safeguards reduce unnecessary request bursts, but they cannot guarantee that a source service will never throttle or reject your connection.

LVOVD is **not** a VPN, proxy, Tor client, anonymity service, DRM bypass, or access-control bypass.

The default server bind is `127.0.0.1`, meaning other computers on your network cannot connect unless you deliberately change `HOST`.

## Authentication and cookies

LVOVD does not currently import browser cookies or your logged-in browser session. Private, age-gated, members-only, or otherwise authenticated media may therefore fail even when yt-dlp recognizes the service.

## Temporary files

LVOVD prepares media inside a fresh, randomly named workspace under your operating system's temporary directory for each server run. Ready files remain available locally for about one hour while the server is running, and the UI provides **Clear prepared files now**. LVOVD cleans job files it still owns while the server is running. If the server stops before a job is cleaned—for example, because its terminal is closed—the operating system may retain that run's temporary folder until its normal temporary-file cleanup or manual removal.

Large downloads may require enough free space for both intermediate and finished files.

## Download history

LVOVD keeps a small, versioned `history.json` file in the current user's local application-data directory. The persistence/API foundation records terminal **Ready**, **Failed**, and **Cancelled** jobs so useful metadata can survive a browser or server restart. A visible History panel and intentional **Use Again** workflow are the next UI slice; history does not silently start source requests or downloads.

A history entry can include the source page URL (and selected playlist-item page URLs), normalized download choices, a bounded title/source label from Preview, output filename/type/size metadata, completion time, and failure information. It does **not** copy the media itself.

LVOVD deliberately does not store temporary workspace paths, runtime `/api/download/file` links, yt-dlp internal media/CDN URLs, Preview thumbnail URLs, or active process/progress state in history. The browser still decides where its downloaded copy is saved, so LVOVD does not know or store that final path and does not currently provide **Open File/Open Folder** from history. Deleting history metadata does not delete files the browser saved elsewhere.

Default history locations are:

- **Windows:** `%LOCALAPPDATA%\LVOVD\history.json`
- **macOS:** `~/Library/Application Support/LVOVD/history.json`
- **Linux:** `$XDG_DATA_HOME/LVOVD/history.json`, or `~/.local/share/LVOVD/history.json` when `XDG_DATA_HOME` is not set

Developers or portable/custom setups can override the data directory with `LVOVD_DATA_DIR`.

History is supplementary bookkeeping. If it cannot be read or written, normal Preview/download behavior remains available, and a successful download is not turned into a failure merely because its history record could not be saved.

## yt-dlp binary management

LVOVD has **no third-party Node runtime dependencies**. It invokes the official yt-dlp executable directly.

By default LVOVD uses yt-dlp's **nightly** release channel, which the yt-dlp project recommends for regular users because source websites can change faster than stable releases. Every startup hashes the local executable against LVOVD's saved verified checksum. A valid cached executable is reused immediately when LVOVD has checked release freshness within the previous 24 hours, so most starts do not contact GitHub.

Once the recorded freshness check is at least 24 hours old, startup makes a small request for the latest release metadata. If the release tag is unchanged, LVOVD records the new check time and keeps the existing executable. If a newer release exists, LVOVD downloads that release's checksum and binary, verifies the replacement, and switches to it atomically. If the freshness check cannot reach GitHub but the cached executable still passes its local integrity check, LVOVD continues with that verified cached copy rather than failing startup.

You can still force an immediate update check and verified download at any time:

```bash
npm run update-ytdlp
```

To explicitly use the stable channel for an update:

```bash
npm run update-ytdlp -- stable
```

A custom executable can still be supplied with `YTDLP_PATH`. LVOVD does not checksum a user-supplied override because it does not know what release or build you intended to provide.

SHA-256 verification protects against a corrupted or mismatched release download. The checksum is retrieved from the same official GitHub release infrastructure as the binary, so this still ultimately trusts GitHub and the yt-dlp release account; it is not an independent signature-verification system.

## Manual start

If you prefer the terminal:

```bash
node server.js
```

Or, equivalently:

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

You do **not** need to install yt-dlp globally or run `npm install` for LVOVD itself.

## Development

```bash
git clone https://github.com/landonrivers/LVOVD.git
cd LVOVD
npm run check
npm start
```

LVOVD uses Node.js 22+, plain HTML/CSS/JavaScript in `public/`, `server.js` as the localhost security gate, `app-server.js` for application/download logic, `history-store.js` / `download-history.js` for local terminal-job history, and `ytdlp-manager.js` for verified project-local yt-dlp binary management. `scripts/launch.js` is shared launcher plumbing behind the three OS-specific start files.

Useful environment variables:

```text
PORT=3000
HOST=127.0.0.1
YTDLP_PATH=/optional/custom/path/to/yt-dlp
LVOVD_YTDLP_CHANNEL=nightly
LVOVD_DATA_DIR=/optional/local/data/path
```

Keep `HOST=127.0.0.1` unless you intentionally want to change LVOVD's network exposure.

## AI-generated project

LVOVD was initially generated and iteratively developed with **ChatGPT by OpenAI** in collaboration with the project owner. AI-generated code should be reviewed like any other code; contributions that improve correctness, security, maintainability, accessibility, and compatibility are welcome.

## License

LVOVD v2.2.6 and later are licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The `NOTICE` file preserves the project's origin attribution. Releases through **v2.2.5** remain available under the MIT License terms under which they were originally published; changing the license for later versions does not revoke those earlier grants.

## Acknowledgements

LVOVD is a small UI/orchestration layer around:

- yt-dlp: https://github.com/yt-dlp/yt-dlp
- FFmpeg: https://ffmpeg.org/
- SponsorBlock: https://sponsor.ajay.app/
