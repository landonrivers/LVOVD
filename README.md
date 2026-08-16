# LVOVD

## Landon's Very Own Video Downloader

**A Locally Hosted Video Downloader Which You'll Use Responsibly**

![LVOVD in use](example.png)

You're here because you don't trust any of those browser extensions or sketchy sites right? Well I'm sure you have the good sense to trust yourself, right? Oh you don't? Well allow me to further your plight. Anywho, here's some **SLOP** that I made in one night.

## In A Nutshell

Locally hosted. No middleman. Paste in a URL from a site with a video in it. This lets you configure a download in many ways.

LVOVD is a local web interface for yt-dlp + FFmpeg. Paste an HTTP/HTTPS media URL and LVOVD asks yt-dlp to identify it, discovers what that particular source exposes, builds the download controls from those capabilities, and lets your own computer do the downloading and processing.

> Use this tool only for media you own, public-domain material, or content you otherwise have permission to download. Respect the source service's terms and applicable copyright law.

## Quick start

Already have **Node.js 22+** and **FFmpeg on PATH**? You can be running LVOVD in a minute:

```bash
git clone https://github.com/landonrivers/LVOVD.git
cd LVOVD
npm i
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

If you do not already have Node.js or FFmpeg set up, continue with [Requirements](#requirements) and [Install and run](#install-and-run) below.

## Table of contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
  - [Node.js 22 or newer](#nodejs-22-or-newer)
  - [FFmpeg on PATH](#ffmpeg-on-path)
- [Install and run](#install-and-run)
- [What `npm i` installs](#what-npm-i-installs)
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

On Windows 10/11, the easiest setup is to install both dependencies with **WinGet** from Windows Terminal, PowerShell, or Command Prompt:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg.Essentials -e
```

After both commands finish, close and reopen your terminal before verifying the installations.

### Node.js 22 or newer

LVOVD requires **Node.js 22 or newer**. A current LTS release is recommended.

#### Windows — easiest method

Install the current Node.js LTS release with WinGet:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

Then close and reopen your terminal and verify both Node and npm:

```powershell
node --version
npm --version
```

If you prefer a normal graphical installer, download the **LTS** Windows installer from the official Node.js site:

https://nodejs.org/en/download

The standard Node installer normally adds both `node` and `npm` to PATH for you.

Node 22 is the minimum because current yt-dlp can use Node as its external JavaScript runtime for sites that require JavaScript challenge solving, including current YouTube extraction.

### FFmpeg on PATH

LVOVD needs FFmpeg available as the `ffmpeg` command on your PATH.

#### Windows — easiest method

Install the **Gyan FFmpeg Essentials Build** with WinGet:

```powershell
winget install --id Gyan.FFmpeg.Essentials -e
```

Gyan also documents this equivalent command:

```powershell
winget install "FFmpeg (Essentials Build)"
```

The package-ID form is shown first here because it identifies the exact WinGet package. The **Essentials Build is enough for LVOVD**; the larger Full build is not required for LVOVD's current download, merge, remux, and audio-conversion features.

After installation, close and reopen your terminal, then verify:

```powershell
ffmpeg -version
```

If that prints FFmpeg version/build information, LVOVD can use it.

#### Windows — manual fallback

If WinGet is unavailable or you prefer a portable installation, FFmpeg's official download page links Windows users to ready-to-run builds from **gyan.dev** and **BtbN**:

https://ffmpeg.org/download.html

For LVOVD, choose a compiled **release essentials** build, extract it somewhere permanent, find the folder containing `ffmpeg.exe` (usually the build's `bin` folder), and add that folder to your Windows `Path` environment variable. Then open a new terminal and run `ffmpeg -version`.

#### macOS / Linux

You can use the platform/package-manager options linked from the official FFmpeg download page. The only requirement for LVOVD is that this succeeds in a terminal:

```bash
ffmpeg -version
```

## Install and run

Clone or download this repository, open a terminal in the project folder, and run:

```bash
npm i
node server.js
```

Then open:

```text
http://127.0.0.1:3000
```

You can also use:

```bash
npm start
```

which is simply an npm shortcut for `node server.js`.

There is no required Windows `.bat` launcher. Node, npm, and FFmpeg being available on PATH is enough.

## What `npm i` installs

You do **not** need to install yt-dlp globally.

LVOVD uses the npm package `ytdlp-nodejs`. During installation it manages a project-local yt-dlp executable under `node_modules`. The server invokes that managed copy directly.

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
├── test/
│   ├── options.test.js
│   └── security.test.js
├── app-server.js
├── server.js
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── README.md
├── example.png
├── package.json
└── package-lock.json
```

The application intentionally has no front-end framework and only one runtime npm dependency. The UI is plain HTML/CSS/JavaScript. `server.js` provides the localhost request-security boundary, while `app-server.js` contains the application server and invokes yt-dlp / FFmpeg as subprocesses.

## AI-generated project

LVOVD was initially generated and iteratively developed with **ChatGPT by OpenAI** in collaboration with the project owner.

It is intentionally open for experimentation and expansion. Pull requests, cleanup, refactors, source-service improvements, new yt-dlp features, better testing, authentication support, and UI improvements are welcome.

AI-generated code should be reviewed like any other code. Contributions that improve correctness, security, maintainability, accessibility, and documentation are especially welcome.

## Development

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