# LVOVD Roadmap

LVOVD is already a capable local-first downloader. The next work should focus less on adding arbitrary yt-dlp switches and more on making the application safer, easier to operate, more transparent, and easier to distribute.

This roadmap is directional rather than a promise of dates or release numbers. Individual slices should stay small enough to review and test independently.

## Current baseline

LVOVD currently provides:

- metadata-driven Preview and capability discovery;
- Video + Audio, Video Only, Audio Only, and Extras Only workflows;
- Compatible MP4 and Maximum Quality video profiles;
- Source Audio plus local FFmpeg conversion to M4A/AAC, MP3, Opus, FLAC, and WAV;
- resolution limits, custom ranges, chapters, playlists, subtitles/captions, thumbnails, metadata, and optional SponsorBlock integration;
- real download progress, speed, ETA, and processing stages;
- coordinated Preview/download source work with serialized remote acquisition;
- a visible queue with authoritative queued/running/ready/error/cancelled job state and cancellation;
- durable local terminal-job history with intentional capability-safe Use Again;
- randomized courtesy pauses between selected playlist items;
- stop-on-rejection behavior instead of aggressive automatic retries;
- a project-managed, SHA-256-verified yt-dlp executable with bounded update checks;
- cross-platform launchers for Windows, macOS, and Linux;
- a loopback-first local security model.

## Near term — Safety and application workflow

### 1. Source-request coordination — completed

LVOVD now coordinates application-controlled Preview and download work through one source-request coordinator.

Established behavior:

- avoid LVOVD-controlled Preview/download overlap and accidental duplicate Preview bursts;
- preserve the one-at-a-time remote acquisition model;
- keep strong rate-limit/rejection signals fail-closed rather than adding retry storms;
- distinguish application-level pacing from yt-dlp's own internal requests rather than claiming a universal "safe" request rate.

### 2. Download queue and cancellation — completed

LVOVD now has a visible session queue without parallel remote downloads, plus server-authoritative cancellation.

Established behavior:

- multiple intended downloads can be lined up;
- only one remote acquisition runs at a time;
- queued jobs can be removed and active jobs can be cancelled;
- cancellation owns the relevant yt-dlp/FFmpeg child and aborts playlist courtesy waits;
- accepted cancellation cannot later become Ready or ordinary Failed;
- queued, active, processing, prepared, failed, cancelling, and cancelled states are explicit;
- prepared jobs remain in the session queue while their temporary files are available for download;
- no automatic retry behavior amplifies a source-side rejection.

### 3. Durable local download history — completed

LVOVD keeps useful local terminal-job records after temporary prepared files expire.

Established behavior:

- terminal Ready, Failed, and Cancelled jobs are stored in a versioned local JSON history store;
- history retains source page/item URLs, normalized request choices, bounded display metadata, output metadata, terminal timestamps, and failure details;
- temporary paths, runtime download URLs, yt-dlp internal media/CDN URLs, Preview thumbnail URLs, browser final save paths, and process/progress state are deliberately excluded;
- the visible History panel loads automatically, shows recent records with expandable details, and supports per-record Delete plus explicit Clear All;
- **Use Again** returns through a fresh Preview and restores only still-compatible historical choices; it never starts a download automatically;
- live terminal jobs refresh History by exact job identity with a small bounded retry for supplementary persistence timing;
- session queue thumbnails remain runtime-only and are not added to durable history.

The browser remains responsible for the user's final saved download location. LVOVD knows its temporary prepared-file path but does not reliably know where the browser ultimately saved the user's copy, so **Open File/Open Folder is deferred** unless a future feature explicitly makes LVOVD responsible for choosing/managing a final output folder.

Persisting live/queued work across a server restart is also separate from download history; it would require its own crash-recovery/scheduler design and is not part of this roadmap item by default.

## Next — Power without clutter

### 4. Advanced source format explorer — in progress

Expose more of the format metadata yt-dlp reports without replacing LVOVD's simple defaults.

The first slice adds a collapsed, read-only format explorer to the existing Preview response. It shows bounded normalized media-format evidence such as format ID, audio/video presence, resolution, FPS, codec, container, bitrate, and size when yt-dlp reports them. It does not expose yt-dlp transport/CDN URLs, make an additional source request, or change the selected download format.

Goals:

- keep Compatible MP4 and Maximum Quality as the primary choices;
- show source formats with understandable resolution, FPS, codec, audio/video presence, bitrate/size estimates when known — read-only inspection is now established;
- allow advanced manual format selection only when the metadata supports it safely — still deferred to a later bounded slice;
- continue treating missing metadata as unknown rather than absent.

### 5. Better failure and compatibility explanations

Expand the existing error classification so users can understand why a Preview or download failed.

Potential categories include:

- source request limiting;
- ambiguous access rejection;
- authentication-required content;
- unavailable/private/deleted content;
- extractor/source compatibility changes;
- unavailable requested formats;
- FFmpeg/local-processing failures;
- local disk/file errors.

The UI should explain what the user can reasonably do next without pretending LVOVD can bypass source restrictions.

### 6. Local edit staging

Add an optional editing path before finalizing a download, while preserving the current straight-through download path for users who do not need edits.

Goals:

- present two clear choices after Preview: download normally or open an Edit/Staging workspace;
- provide an understandable playback timeline rather than requiring users to type every timecode manually;
- allow start/end trimming as well as multiple authored cuts so unwanted sections in the middle can be removed;
- let users review the intended keep/remove ranges before processing;
- keep editing local after source acquisition, using FFmpeg rather than increasing source requests;
- preserve the highest practical quality by using lossless stream-copy operations when technically safe and re-encoding only when the requested edit requires it;
- keep SponsorBlock separate and optional: authored user cuts and SponsorBlock-provided segments may share editing machinery later, but neither should silently enable the other.

The editing workspace should remain a focused trim/stitch tool rather than growing into a general-purpose nonlinear video editor.

### 7. Local media converter

Consider a separate local-only utility for existing media files using the FFmpeg dependency LVOVD already requires.

Potential uses:

- remux compatible media without re-encoding;
- create editor-friendly MP4 output;
- convert existing audio/video files to supported local formats;
- show local conversion progress and cancellation.

This feature should remain clearly separate from source acquisition.

## Major milestone — Easier desktop distribution

Reduce setup friction so normal users do not need to understand the runtime stack.

### 8. Packaged desktop distribution

Investigate a supported desktop package that can run without a separate user-managed Node.js installation.

Priorities:

1. Windows first;
2. determine the safest way to bundle or manage Node.js;
3. determine whether FFmpeg can be bundled or managed responsibly and legally across target platforms;
4. preserve the existing verified yt-dlp update model or replace it only with something equivalently transparent;
5. evaluate installer/update signing and release-security requirements before treating packaged builds as the default distribution;
6. consider macOS and Linux packages after the Windows path is proven.

A mobile application is not currently planned. LVOVD's filesystem, yt-dlp, and FFmpeg workflows fit a desktop utility much better than a mobile distribution model.

## Risk-gated or intentionally out of scope

These should not become convenience settings merely because yt-dlp can expose them.

### Browser cookies / authenticated sessions

Not planned by default.

Authenticated downloading can associate automated yt-dlp activity with a user's service account and can carry account-restriction risk. Any future authenticated-content support requires its own explicit product, privacy, and safety review before implementation.

### Proxy rotation or block evasion

Not planned.

LVOVD should not add proxy rotation, anti-block systems, DRM bypasses, access-control bypasses, or similar behavior intended to defeat source restrictions.

### Parallel remote acquisition

Not planned.

The queue improves convenience while remote source acquisition remains serialized. Changing that safety model would require a compelling, separately reviewed reason.

## Product principles that continue to apply

- Preview is the compatibility/capability probe.
- Prefer normalized yt-dlp metadata over per-service hardcoding.
- Do not promise that every yt-dlp-supported site or URL will always work.
- Missing metadata means unknown, not automatically absent.
- Compatible MP4 means native H.264/AAC where available; Maximum Quality preserves the best qualifying source streams and native codecs.
- Source Audio downloads the best source audio unchanged; converted audio formats are produced afterward from the local file with FFmpeg.
- SponsorBlock remains optional and off by default.
- LVOVD is local-first, not anonymous. Source services still see the user's network requests.
- Keep the default server bind local-only and do not weaken the loopback security model for convenience.
- Do not add DRM or access-control bypass behavior.
