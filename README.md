# LVOVD  
## Landon's Very Own Video Downloader

***"A Locally Hosted Video Downloader Which You'll Use Responsibly"***  
You're here because you don't trust any of those browser extensions or sketchy sites right? Well I'm sure you have the good sense to trust yourself, right? *Oh you don't*? Well allow me to further your plight. Anywho, here's some **SLOP** that I made.

![LVOVD in use](example.png)  

LVOVD is a local browser UI for **yt-dlp + FFmpeg**. Paste a media URL to download it, or bring local files into the workbench, and **let your own computer do the work**.

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
- Choose or drop multiple video/audio files into the unified **Local Media** workbench; select a file in **Files** to work on it. Source facts and output settings sit alongside the visual timeline; Media Details remains expandable.
- Use **Process Selected File** to apply committed cuts and output settings directly to the original working source. H.264 controls offer quality, average bitrate, or a maximum complete output size, with aspect-preserving fit and optional frame-rate reduction. Applicable outputs include MP4, MOV, MKV, M4A/AAC, and MP3.
- Use **Edit Source Video** after an eligible single, non-live URL Preview. URL Edit respects the selected source, Compatible/Maximum profile, resolution, and Manual source choice, then acquires that source once into temporary workspace storage.
- Visually trim the overall Start/End, remove and restore multiple middle sections, and navigate with a zoomable/pannable timeline, draggable handles, keyboard controls, and exact time fields.
- Create and download a real edited result while leaving the workspace source unchanged.

Defaults keep codec, container, picture, cadence, and audio unchanged. A complete no-op downloads the existing owned bytes. Cuts or encoding settings can require re-encoding even when the codec stays H.264; other source codecs require an explicit supported choice. Pending cuts remain pending until applied. Each file keeps its own requested settings, cuts, pending cut, playhead, and zoom in a temporary profile; changing them marks an existing result as an older revision and never processes automatically.

Selecting a video in the **Files** list automatically prepares seekable playback from that original workspace source. Compatible media plays directly; a local proxy is prepared only when required. **Retry Preview** is available after a failure, and final processing always reads the original. **Reset File** resets cuts/settings while keeping that source and any correctly labelled prior result. **Remove File** invalidates only the selected workspace, cancels its queued/running work, and attempts owned-file cleanup. Cancellation retains the editing session and previous successful output. Open downloads and referenced no-op bytes remain owned until safe retirement; failed cleanup blocks further file creation until retry succeeds.

**Process Selected File** queues the selected reviewed draft. **Process All Files** first lists each file and its warnings; choose the eligible drafts to queue. Already queued/running files and drafts with a successful download are excluded from that batch review. Complete unchanged files use their original bytes without an encode. The queue runs one processing job at a time; **Cancel All** cancels waiting work and requests termination of the active job. Later edits do not change an already queued snapshot, and a failed file does not discard other results. Each file retains its own Download.

**Apply output settings to all** is one checkbox, enabled by default for a fresh workbench. Checking it copies every output setting, including the filename suffix, to all files; while checked, further setting changes and newly added files use those settings. Uncheck to edit one file independently. Cuts and view state stay individual, queued work and previous downloads stay unchanged, and nothing starts automatically. Every destination is reviewed against its own media; incompatible settings stay visible for correction. **Reset File** turns sharing off and resets only the selected file.

A workbench accepts up to **20 files**, copied one at a time. The server allows two workbenches, at most 20 queued/running processing jobs, and **100 GiB of aggregate original-source reservations** across them. Removed sources with pending cleanup still consume that budget. This is not a total disk-space guarantee: proxies, retained/results, attempts, and pass logs consume additional temporary storage under existing per-workspace limits. Queued jobs expire after one hour without starting; sources and previous downloads remain available for another review under normal workspace expiry. Profiles and queue state are not persisted across reloads or restarts.

Video bitrate, audio bitrate, and file size stay visible together. Enter a video bitrate to estimate size, or a maximum size to calculate the video budget; cuts and audio settings update that calculation. The summary distinguishes exact original bytes, approximate bitrate/remux estimates, and variable quality-based size. Scale includes ordinary dimension presets, width/height-only choices, and 50%/25%; actual dimensions are labelled as adjusted to fit aspect. No AI upscaling is included.

The **?** controls explain quality, bitrate, audio, file size, encoding speed, and two passes, with suggested trial values. Hover or focus for help; click/tap to keep it open, and Escape or click outside to dismiss. Bitrate is an average target and can undershoot, especially in one pass. Review and completed-result sizes use decimal MB consistently; the result also shows exact bytes and the measured video bitrate when available. The selected Control identifies which value drives the linked calculation; CRF quality cannot independently guarantee bitrate and size.

**Add a suffix**, beside **Process Selected File**, controls the reviewed download name (default `-processed`; uncheck for no suffix). It also names byte-identical no-op downloads without changing or copying source bytes. A new suffix creates a new draft and never renames an earlier completed result.

Maximum size uses decimal MB (1 MB = 1,000,000 bytes) per complete output, retained duration, an audio budget, and container reserve. H.264 runs two passes directly from the original, with at most one bitrate correction; an oversized result is rejected. It never silently lowers resolution, removes audio, or downmixes to meet the limit. Temporary storage includes input, optional preview, previous/new results, pass logs, and cleanup-pending files. Local files can be processed sequentially; playlist intake remains deferred.

Default video encoding uses H.264, CRF 18, medium, yuv420p, and minimal padding for odd dimensions; explicit quality/rate settings override those defaults. AAC defaults to 128/256/512 kbps for mono/stereo/supported 5.1; MP3 defaults to quality 0 for mono/stereo. Encoding retains 44.1/48 kHz, otherwise resamples to 48 kHz with a notice. Copying retains source parameters. Known HDR, alpha, unsupported transforms, and unsupported channel changes are refused for the affected target. Some native AAC builds cannot produce a verifiable `5.1(side)` layout; such results fail validation and are not downloadable. See the [workspace contract](docs/local-media-workspace.md) for timing, omission, and temporary-storage limits.

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

For **Edit Source Video**, Compatible/Maximum, the selected resolution, and any Manual source override control which source is acquired into the temporary editor workspace. Local output settings are selected separately in the workbench and do not cause another acquisition.

### Audio

**Source Audio** keeps the best available source audio unchanged.

Choosing MP3, M4A/AAC, Opus, FLAC, or WAV still downloads source audio first, then converts the local file with FFmpeg. The selected output format does not change remote media acquisition.

### Local video editing

Select a local video from the workbench to edit it, or open an eligible single, non-live URL Preview through **Edit Source Video**. URL editing acquires the selected source once; it does not apply the Download-only Time Range, Extras, or SponsorBlock controls.

The browser player and timeline let you set reversible outer Start/End bounds, remove and restore middle sections, seek, zoom, pan, drag handles, use exact time fields, and adjust focused handles with the keyboard. The final retained ranges stay in their original chronological order.

Choose H.264, MP4, and AAC (when audio exists) with Automatic rate for the existing high-quality H.264 MP4 policy, with AAC when the source has audio. **Process Selected File** applies the committed cuts and these settings together. LVOVD re-encodes cuts to closely honor arbitrary authored boundaries; this is not lossless and does not imply frame-perfect output. The workspace source remains unchanged. Other source codecs need an explicit supported choice when cuts require encoding; the planner never silently substitutes H.264.

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

**URL editing also contacts the source:** choosing **Edit Source Video** acquires the selected source once into temporary storage on this computer. The source service sees those acquisition requests. Playback, timeline editing, and rendering happen locally after acquisition, and LVOVD does not upload the workspace media to cloud storage.

LVOVD is **not** a VPN, proxy, Tor client, anonymity service, DRM bypass, or access-control bypass.

The default server bind is `127.0.0.1`, meaning other computers on your network cannot connect unless you deliberately change `HOST`.

## Authentication and cookies

LVOVD does not currently import browser cookies or your logged-in browser session. Private, age-gated, members-only, or otherwise authenticated media may therefore fail even when yt-dlp recognizes the service.

LVOVD passes `--ignore-config` to its yt-dlp operations. Unrelated user/system yt-dlp option files are not inherited; use LVOVD's explicit download choices instead. Default extractor-plugin discovery and the `YTDLP_PATH` custom-executable override remain available.

## Temporary files

Download jobs prepare their intermediate and ready files inside process-owned temporary storage. Ready download files remain available locally for about one hour while the server is running, and the queue provides **Clear prepared files now**.

Edit uses a separate temporary media workspace. Local-file intake copies the chosen file into that workspace; URL Edit downloads its selected source into the workspace once. A browser-compatible playback proxy and an edited output may each require additional temporary disk space. **Discard** immediately invalidates workspace access and attempts to remove the source, proxy, edited output, and other owned assets. If deletion fails, LVOVD reports cleanup as pending or unsuccessful and retains ownership in memory. Transient lock failures receive at most two automatic retries; permission failures are not retried indefinitely. New work can begin after logical Discard even if some old temporary files remain. An idle workspace expires while the server is running; keeping the editor open and connected counts as activity.

Local editing accepts self-contained media in a bounded set of containers, including normal MP4/MOV, Matroska/WebM, AVI, and MPEG-TS. Playlists/reference inputs and unlisted containers (including MXF and raw elementary video) are rejected with a local-input explanation, regardless of filename or browser MIME type. MOV external tracks are disabled. This policy covers inspection, playback proxies, and edited rendering; it does not restrict yt-dlp's normal remote HLS/DASH acquisition. See [SECURITY.md](SECURITY.md#local-media-input-and-cleanup-boundaries) for the exact policy and limitations.

If the server stops before owned temporary data is cleaned—for example, because its terminal is closed—the operating system may retain that run's temporary folder until normal temporary-file cleanup or manual removal. Large downloads and editing sessions can therefore require space for the working source, intermediate/proxy data, and prepared output at the same time.

The browser controls the final save destination for downloaded or edited files. That saved copy is outside LVOVD's temporary-workspace authority, and LVOVD does not know or clean its final path.

## Download history

LVOVD keeps a small, versioned `history.json` file in the current user's local application-data directory. The visible **Download History** panel records terminal **Ready**, **Failed**, and **Cancelled** download jobs so useful metadata can survive a browser or server restart. Its intentional **Use Again** action returns through a fresh Preview and restores only choices that remain compatible; it never silently starts a source request or download.

A history entry can include the source page URL (and selected playlist-item page URLs), normalized download choices, a bounded title/source label from Preview, output filename/type/size metadata, completion time, and failure information. It does **not** copy the media itself.

LVOVD deliberately does not store temporary workspace paths, runtime `/api/download/file` links, yt-dlp internal media/CDN URLs, Preview thumbnail URLs, or active process/progress state in history. The browser still decides where its downloaded copy is saved, so LVOVD does not know or store that final path and does not currently provide **Open File/Open Folder** from history. Deleting history metadata does not delete files the browser saved elsewhere.

Edit workspace activity and edited outputs are not currently persisted in Download History. History does not store Edit workspace IDs, temporary source paths, playback proxies, edited-output paths, or browser save paths.

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
