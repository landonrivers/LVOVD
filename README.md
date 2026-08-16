# LVOVD

## Landon's Very Own Video Downloader

**A Locally Hosted Video Downloader Which You'll Use Responsibly**

![LVOVD in use](example.png)

You're here because you don't trust any of those browser extensions or sketchy sites right? Well I'm sure you have the good sense to trust yourself, right? Oh you don't? Well allow me to further your plight. Anywho, here's some **SLOP** that I made in one night.

## In A Nutshell

Locally hosted. No middleman. Paste in a URL from a site with a video in it. This lets you configure a download in many ways.

LVOVD is a local web interface for yt-dlp + FFmpeg. Paste an HTTP/HTTPS media URL and LVOVD asks yt-dlp to identify it, discovers what that particular source exposes, builds the download controls from those capabilities, and lets your own computer do the downloading and processing.

> Use this tool only for media you own, public-domain material, or content you otherwise have permission to download. Respect the source service's terms and applicable copyright law.

## Quick start — no Git required

You do **not** need Git or GitHub Desktop to use LVOVD.

1. [Download LVOVD as a ZIP](https://github.com/landonrivers/LVOVD/archive/refs/heads/master.zip).
2. Extract the ZIP somewhere permanent, such as your Documents folder.
3. Install **Node.js 22+** and **FFmpeg** using the instructions for your operating system below.
4. Start LVOVD with the launcher for your operating system.

### Windows

Double-click:

```text
Windows-Start-LVOVD.bat
```

### macOS

Double-click:

```text
Mac-Start-LVOVD.command
```

If macOS will not launch it directly, open Terminal in the LVOVD folder and run:

```bash
bash Mac-Start-LVOVD.command
```

### Linux

From a terminal in the LVOVD folder, run:

```bash
./Linux-Start-LVOVD.sh
```

If your archive tool did not preserve the executable bit, this works too:

```bash
sh Linux-Start-LVOVD.sh
```

The launcher checks that Node and FFmpeg are available. If LVOVD's project dependencies are missing or out of date, it runs `npm install` automatically; otherwise it skips npm and starts the local server directly. It then opens `http://127.0.0.1:3000` in your default browser when the server is ready.

**Keep the launcher terminal window open while using LVOVD.** Closing it stops the local server.

## Table of contents

- [Quick start — no Git required](#quick-start--no-git-required)
- [Requirements](#requirements)
  - [Windows](#windows-1)
  - [macOS](#macos-1)
  - [Linux](#linux-1)
- [Starting LVOVD](#starting-lvovd)
- [Manual start](#manual-start)
- [What the first launch installs](#what-the-first-launch-installs)
- [What it can do](#what-it-can-do)
- [Source services](#source-services)
- [Generic source capability discovery](#generic-source-capability-discovery)
- [Does everything run locally?](#does-everything-run-locally)
- [Privacy, networking, and limitations](#privacy-networking-and-limitations)
- [Download modes](#download-modes)
- [Resolution selection](#resolution-selection)
- [Time ranges and chapters](#time-ranges-and-chapters)
- [Subtitles](#subtitles)
- [SponsorBlock](#sponsorblock)
- [Playlists and collections](#playlists-and-collections)
- [Temporary files](#temporary-files)
- [Project structure](#project-structure)
- [AI-generated project](#ai-generated-project)
- [Development](#development)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Requirements

LVOVD needs two things installed on the computer:

- **Node.js 22 or newer** — a current LTS release is recommended.
- **FFmpeg on PATH** — the normal/Essentials builds are enough; LVOVD does not require an oversized “Full” FFmpeg build.

Once those are installed, the LVOVD launcher handles the project-local npm/yt-dlp setup for you.

### Windows

The easiest Windows 10/11 setup is **WinGet**. Open Windows Terminal, PowerShell, or Command Prompt and run:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg.Essentials -e
```

Gyan also documents this equivalent FFmpeg command:

```powershell
winget install "FFmpeg (Essentials Build)"
```

After both installs finish, **close and reopen your terminal**. Verify everything with:

```powershell
node --version
npm --version
ffmpeg -version
```

If those commands print version information, you are ready to double-click `Windows-Start-LVOVD.bat`.

#### Windows alternatives

If you prefer a graphical Node installer, download the current **LTS** installer from:

https://nodejs.org/en/download

The standard Node installer normally adds both `node` and `npm` to PATH.

If WinGet is unavailable for FFmpeg, the official FFmpeg download page links Windows users to compiled builds from **gyan.dev** and **BtbN**:

https://ffmpeg.org/download.html

For LVOVD, Gyan's **Essentials** build is sufficient. A manual portable install must have the folder containing `ffmpeg.exe` added to Windows `Path`.

### macOS

For Node.js, the easiest route for most people is the official **LTS macOS installer** from:

https://nodejs.org/en/download

For FFmpeg, Homebrew provides a ready-to-run build:

```bash
brew install ffmpeg
```

If you do not already have Homebrew, install it from:

https://brew.sh/

The regular Homebrew `ffmpeg` formula is enough for LVOVD; `ffmpeg-full` is not required.

After installation, open a new Terminal window and verify:

```bash
node --version
npm --version
ffmpeg -version
```

Then use `Mac-Start-LVOVD.command` from the extracted LVOVD folder.

If you do not want Homebrew, FFmpeg's official download page also links to compiled macOS builds, but a manual install may require placing the executable somewhere on PATH:

https://ffmpeg.org/download.html

### Linux

Linux distributions differ, so there is not one universal installer command. The goal is the same: a **Node.js 22+ LTS release** and an `ffmpeg` command available on PATH.

The official Node.js download page currently recommends **nvm** for Linux. The current nvm installer can be installed with:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
```

Close and reopen the terminal, then install the current Node LTS release:

```bash
nvm install --lts
```

On Debian or Ubuntu, FFmpeg is normally available through apt:

```bash
sudo apt update
sudo apt install ffmpeg
```

For Fedora, Arch, and other distributions, use the FFmpeg package provided by your distribution or follow the package links from:

https://ffmpeg.org/download.html

Verify before starting LVOVD:

```bash
node --version
npm --version
ffmpeg -version
```

Then run `./Linux-Start-LVOVD.sh` from the extracted LVOVD folder.

## Starting LVOVD

The included launchers are intended to be the normal way to start LVOVD after Node and FFmpeg are installed:

- **Windows:** double-click `Windows-Start-LVOVD.bat`.
- **macOS:** double-click `Mac-Start-LVOVD.command` or run `bash Mac-Start-LVOVD.command`.
- **Linux:** run `./Linux-Start-LVOVD.sh` or `sh Linux-Start-LVOVD.sh`.

On a fresh download—or after LVOVD's npm dependency changes—the launcher runs `npm install` for you. Once the required dependency is already installed at the expected version, future launches skip npm and start the local Node server directly. The launcher then attempts to open your default browser to:

```text
http://127.0.0.1:3000
```

If the browser does not open automatically, open that address yourself.

Keep the terminal window open while using LVOVD. To stop LVOVD, close that terminal or press `Ctrl+C`.

## Manual start

If you prefer the terminal or are developing LVOVD, the launchers are optional. From the project folder:

```bash
npm i
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

`npm start` is simply an npm shortcut for `node server.js`.

Git is **not required to run LVOVD**. Developers who want to contribute or keep a working clone can use Git normally; see [Development](#development).

## What the first launch installs

You do **not** need to install yt-dlp globally.

LVOVD uses the npm package `ytdlp-nodejs`. When the launcher needs to run `npm install`, that package manages a project-local yt-dlp executable under `node_modules`. The server invokes that managed copy directly.

To update the project-local yt-dlp later:

```bash
npm run update-ytdlp
```

## What it can do

- Paste a URL without choosing a service first: LVOVD lets **yt-dlp detect the source/extractor**.
- Build the preview UI from the capabilities yt-dlp actually reports for that URL.
- Show the detected source, extractor, media availability, H.264/AAC availability, thumbnails, subtitles, chapters, metadata, and source-specific features.
- Disable options that the inspected source does not actually expose instead of assuming every service behaves like YouTube.
- Distinguish common preview failures such as unsupported URLs, sign-in/authentication requirements, unavailable media, region restrictions, request blocking, and DRM-protected media.
- Download **Video + Audio**.
- Download **Video Only (No Audio)**.
- Download **Audio Only (No Video)**.
- Download **Extras Only** such as thumbnails, subtitles, or metadata.
- Prefer **Compatible MP4** using native H.264 video + AAC audio when the source service offers it.
- Choose **Maximum Quality** when resolution matters more than codec compatibility.
- Cap video output to a selected maximum resolution.
- Export audio as M4A/AAC, MP3, Opus, FLAC, WAV, or keep the **Source Audio** without conversion.
- Download a custom time range.
- Download one or more detected chapters as separate files.
- Download creator subtitles and/or automatic captions as SRT when the source exposes them.
- Download thumbnails as JPG.
- Download yt-dlp's `.info.json` metadata.
- Preview playlists or collections, select individual entries, or select the whole previewed batch when yt-dlp exposes usable entry URLs.
- Use SponsorBlock to mark or remove selected segment categories where supported.
- See real yt-dlp download percentage, byte counts, speed, ETA, and processing stages.

## Source services

LVOVD itself does not implement site-specific download logic. It passes supported HTTP/HTTPS URLs to **yt-dlp**, which contains extractors for many video services.

The current yt-dlp supported-sites list includes extractors for services such as:

- YouTube
- Vimeo
- TikTok
- Instagram
- Facebook, including Facebook Reels
- Twitch
- many other video and media sites

See yt-dlp's current supported-sites list:

https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md

**Important:** a site appearing in yt-dlp's supported list does not guarantee that every URL will always work. Video services change frequently, some features differ by service, and some media requires authentication or browser cookies. The yt-dlp project itself recommends trying the URL as the reliable way to determine whether it currently works.

LVOVD's earliest development and most hands-on download testing was done with YouTube URLs, but the application no longer has a YouTube-specific preview gate. **Preview is the compatibility test:** paste the URL and LVOVD asks the installed yt-dlp build to inspect it. If extraction succeeds, LVOVD uses the returned metadata to decide which controls to expose.

Other services should still be considered best-effort because extractors can break when sites change. Authentication/cookie support is a natural future expansion, particularly for Facebook and Instagram content that is not anonymously accessible.

## Generic source capability discovery

LVOVD 2.2 treats yt-dlp as the source-service intelligence layer. There is no maintained LVOVD table that says “Facebook supports these buttons” or “Vimeo supports those buttons.” Instead, a preview follows this model:

```text
Paste URL
   ↓
yt-dlp chooses a dedicated or generic extractor
   ↓
yt-dlp returns formats + metadata
   ↓
LVOVD discovers capabilities
   ↓
LVOVD enables only the controls that make sense
```

For a single media item, LVOVD currently derives capabilities from the returned formats, thumbnails, subtitles, chapters, live state, and extractor identity. For a playlist/collection, individual item capabilities can differ, so the UI marks those capabilities as variable and applies the selected settings to each chosen entry.

A source can expose combined media without exposing native video-only or audio-only formats. LVOVD does not claim those modes are available unless the metadata reports separable streams. This avoids presenting controls that are likely to fail on combined-only services.

Preview failures are also classified into useful local messages. LVOVD does **not** bypass DRM, region restrictions, or access controls. Authentication/browser-cookie integration is not included yet.

## Does everything run locally?

Yes. The web server and all media processing run on your computer:

```text
Your browser
    ↓ localhost
LVOVD Node server on your computer
    ↓
project-local yt-dlp
    ↓
FFmpeg on your PATH
    ↓
local temporary files
    ↓
your browser download
```

There is no hosted LVOVD backend and your downloaded media is not uploaded to a separate LVOVD service.

Network access is naturally still required for the services you ask the tool to use:

- yt-dlp connects to the source website to read metadata and download media.
- `npm i` / yt-dlp updates may download dependencies or the yt-dlp executable.
- SponsorBlock is contacted only when you enable SponsorBlock functionality.

The server binds to `127.0.0.1` by default, so other computers on your network cannot connect to it unless you deliberately change `HOST`.

## Privacy, networking, and limitations

### What “local” means in plain English

LVOVD's interface opens in **whatever browser you choose**—Chrome, Firefox, Edge, etc.—but that browser only connects to `127.0.0.1` on your own computer. It displays the controls and receives the finished file. The actual outbound connection to the media site is made by **Node/yt-dlp running locally**, not by the browser.

Your browser can still see what you type into the LVOVD page and may keep normal local browsing/download history. Extensions, security features, or browser telemetry may also observe some activity depending on your browser and settings. That behavior belongs to the browser; LVOVD itself does not send your activity to a hosted LVOVD service.

When you preview or download a URL, the rough path is:

```text
Browser UI on your computer
        ↓ localhost only
LVOVD Node server on your computer
        ↓
yt-dlp on your computer
        ↓ ordinary HTTP/HTTPS requests
Source website / its media CDN
```

The source media therefore travels **from the source service to your computer**. LVOVD does not first upload the URL or video to a hosted LVOVD server, and downloaded media is not sent to ChatGPT or OpenAI by the application. FFmpeg processing also happens locally on your computer.

After the media is prepared, LVOVD serves the finished local file back to your browser over `localhost` so your browser can save it to your normal Downloads location.

### Local does not mean anonymous

LVOVD is designed to avoid adding another hosted service in the middle, but it does **not** hide you from the source website.

The website or CDN you are downloading from can still generally see normal connection information such as your public IP address, request timing, and whatever request metadata is needed to serve the media. Your internet provider or network operator can also generally see which Internet services/domains you connect to, although HTTPS normally encrypts the contents of the connection in transit.

LVOVD is **not a VPN, proxy, Tor client, anonymity tool, DRM bypass, or access-control bypass**. If privacy from the source service itself is your goal, LVOVD does not provide that.

### What leaves your computer

Depending on what you do, network requests may be made to:

- The media website and/or the CDN/API endpoints that yt-dlp needs in order to inspect and download the URL.
- npm and upstream package/download hosts during `npm i` or dependency updates.
- yt-dlp's upstream release host when the project-local yt-dlp executable is installed or updated.
- SponsorBlock **only when you enable SponsorBlock functionality**.

LVOVD itself has no analytics service, advertising service, user account system, cloud database, or hosted telemetry backend.

### Authentication and cookies

LVOVD does not currently import your browser cookies or logged-in browser session. That is why some private, age-gated, members-only, Facebook, Instagram, or otherwise authenticated URLs may be recognized by yt-dlp but still fail to download.

If browser-cookie support is added in the future, it should be treated as sensitive functionality because session cookies can grant access to your account. They should never be uploaded to a third-party LVOVD service or committed to Git.

### Local temporary files

yt-dlp and FFmpeg may create temporary and intermediate media files on your computer while a job is running. LVOVD keeps prepared files available locally for a limited time so your browser can retrieve them, provides a **Clear prepared files now** action, and removes stale LVOVD working directories on later starts. See [Temporary files](#temporary-files) below.

### Do not expose the server casually

The default `HOST=127.0.0.1` is intentional: it means only your own computer can open LVOVD. If you change `HOST` so other devices can reach it, you are changing the security/privacy model and should understand the network exposure you are creating. LVOVD is currently intended primarily as a personal local utility, not as an Internet-facing download service.

## Download modes

### Video + Audio

#### Compatible MP4 — recommended

Asks yt-dlp for native H.264/AVC video and native AAC audio when those formats exist, then uses FFmpeg to merge them into an MP4 container.

This normally avoids a full video re-encode, so it is fast and broadly compatible with video editors. The tradeoff is that some services reserve their highest resolutions for newer codecs such as VP9 or AV1, so the highest compatible H.264 stream may be lower resolution than the absolute maximum-quality stream.

#### Maximum Quality

Downloads the best video stream and best audio stream available at the selected resolution cap, then merges/remuxes them into MP4.

This may retain higher resolutions, high frame rates, VP9, AV1, or Opus. Some editors cannot decode those codecs even when they are stored inside an `.mp4` container.

### Video Only

Produces a video stream with **no audio track**.

Compatible mode prefers native H.264. Maximum mode keeps the best available video-only stream.

### Audio Only

Produces audio with **no video track**.

Available outputs:

- M4A / AAC — broadly compatible.
- MP3.
- Source Audio — keeps the source service's native audio codec/container without conversion.
- Opus.
- FLAC.
- WAV.

### Extras Only

Skips the media download and retrieves only the extras you select, where the source service exposes them:

- Thumbnail.
- Metadata JSON.
- Subtitles / automatic captions.

## Resolution selection

Resolution choices mean **up to this height**, not “this exact format ID.” For example, choosing `1080p` asks yt-dlp for the best qualifying stream at 1080p or below.

The preview shows the resolutions yt-dlp can see for a single video. Playlist batches use common resolution choices because every item may expose different formats.

## Time ranges and chapters

For a single video you can download:

- The full video.
- A custom start/end range such as `00:03:20` to `00:08:45`.
- One or more chapters detected in the source metadata.

Selected chapters are prepared as separate output files.

Time-range work uses yt-dlp's `--download-sections` functionality and FFmpeg.

## Subtitles

When supported by the source, LVOVD can request:

- Manual/creator-provided subtitles.
- Automatic captions.
- Both, allowing yt-dlp to use what is available.

Enter a language code such as `en`. For single videos, the preview also exposes detected language codes as suggestions when yt-dlp reports them.

Subtitles are converted to SRT for convenient editing/import.

## SponsorBlock

SponsorBlock support is optional and off by default. It is only useful on source services/content that SponsorBlock and yt-dlp support.

You can either:

- **Mark** selected SponsorBlock categories as chapters, or
- **Remove** matching segments from the prepared media.

Categories exposed in the UI include sponsor, intro, outro, self-promotion, interaction, and preview segments.

## Playlists and collections

Playlist/collection URLs are previewed as a selectable list when yt-dlp exposes the entries in a usable form. You can select all items or only specific videos, then apply the same output profile to the batch.

The preview intentionally caps itself at 100 entries to keep the local UI manageable.

Custom ranges and chapter selection are intentionally limited to single-video downloads because chapter/timing metadata differs per playlist item.

## Temporary files

yt-dlp and FFmpeg prepare downloads under your operating system's temporary directory in an `lvovd` working folder. Ready files remain available to the local web UI for approximately one hour while the server is running, or you can press **Clear prepared files now** after downloading them.

The server also cleans stale working directories from older runs when it starts.

For very large media, make sure your system temporary drive has enough free space for intermediate and finished files.

## Project structure

```text
lvovd/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   └── pull_request_template.md
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   └── launch.js
├── test/
│   ├── launcher.test.js
│   ├── options.test.js
│   └── security.test.js
├── app-server.js
├── server.js
├── Windows-Start-LVOVD.bat
├── Mac-Start-LVOVD.command
├── Linux-Start-LVOVD.sh
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── README.md
├── example.png
├── package.json
└── package-lock.json
```

The application intentionally has no front-end framework and only one runtime npm dependency. The UI is plain HTML/CSS/JavaScript. `server.js` provides the localhost request-security boundary, while `app-server.js` contains the application server and invokes yt-dlp / FFmpeg as subprocesses. `scripts/launch.js` is internal cross-platform convenience plumbing used by the Windows/macOS/Linux start files; normal users should launch the OS-specific files at the project root instead.

## AI-generated project

LVOVD was initially generated and iteratively developed with **ChatGPT by OpenAI** in collaboration with the project owner.

It is intentionally open for experimentation and expansion. Pull requests, cleanup, refactors, source-service improvements, new yt-dlp features, better testing, authentication support, and UI improvements are welcome.

AI-generated code should be reviewed like any other code. Contributions that improve correctness, security, maintainability, accessibility, and documentation are especially welcome.

## Development

For normal use, download the ZIP and use the launchers above. Git is only needed if you want a development clone or plan to contribute.

Developer setup:

```bash
git clone https://github.com/landonrivers/LVOVD.git
cd LVOVD
npm i
npm run check
npm start
```

Run syntax checks and tests:

```bash
npm run check
```

Useful environment variables:

```text
PORT=3000
HOST=127.0.0.1
YTDLP_PATH=/optional/custom/path/to/yt-dlp
```

Keeping `HOST=127.0.0.1` is recommended unless you intentionally want to expose the local server to another device.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

LVOVD is a small UI/orchestration layer around excellent upstream tools and services, especially:

- yt-dlp: https://github.com/yt-dlp/yt-dlp
- FFmpeg: https://ffmpeg.org/
- ytdlp-nodejs: https://github.com/iqbal-rashed/ytdlp-nodejs
- SponsorBlock: https://sponsor.ajay.app/
