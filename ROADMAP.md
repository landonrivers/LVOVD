# LVOVD Roadmap

LVOVD is already a capable local-first downloader. The next work should focus less on adding arbitrary yt-dlp switches and more on making the application safer, easier to operate, more transparent, and easier to distribute.

This roadmap is directional rather than a promise of dates or release numbers. Individual slices should stay small enough to review and test independently.

## Product vision

LVOVD exists as a practical local alternative to ad-heavy, tracking-heavy online downloader and media-conversion sites. It should be easy to obtain and understand, stay out of the user's way, keep processing local wherever practical, avoid telemetry/profiling, and be precise about the network requests it does make.

The long-term product can grow beyond downloading into a small local media compatibility toolkit, but source acquisition, local editing, and local conversion should remain understandable as distinct jobs rather than becoming one opaque media pipeline.

## Current baseline

**v2.6.0 release checkpoint:** the accepted Roadmap 7A–7D3 work now forms the public Local Media workbench baseline: inspection, original-source cuts plus conversion/compression, independent local files, sequential batch processing, selected playlist intake, compact processed results, Download All, and session-local reopening/cleanup recovery. Landon completed manual acceptance of the final results workflow. This release does not mark all of Roadmap #7 complete; the later codec, image, hardware, track/metadata, and packaging work below remains deferred. See [v2.6.0 release notes](docs/releases/v2.6.0.md).

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
- temporary local-media workspaces shared by local-file and eligible URL editing inputs, with independent local file profiles and a bounded sequential processing queue;
- a browser player and visual multi-cut timeline with real locally rendered H.264/AAC MP4 edited output;
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

### 4. Advanced source format explorer — completed

LVOVD exposes more of the format metadata yt-dlp reports without replacing its simple defaults.

Established behavior:

- Compatible MP4 and Maximum Quality remain the primary choices;
- the collapsed Source Formats panel shows understandable resolution, FPS, codec, audio/video presence, container, bitrate, and size evidence when yt-dlp reports it;
- transport/CDN URLs and raw yt-dlp request details are not exposed to the browser;
- single-media Previews can opt into a capability-safe Manual source override using exact literal format IDs reported by that Preview;
- Video + Audio can use one combined format or an exact video-only + audio-only pair; Video Only and Audio Only accept the matching single-stream role;
- formats with unknown stream composition remain visible for inspection but are not selectable;
- manual selection is deliberately unavailable for flat playlist Preview rather than probing every playlist item;
- the server accepts only conservative literal format IDs and constructs any `video+audio` selector itself; arbitrary yt-dlp selector syntax is not accepted;
- stale manual IDs fail clearly and require a fresh Preview rather than silently substituting another format;
- manual format IDs are Preview-time identities: History records them truthfully, while Use Again requires the user to choose them again after fresh capability discovery;
- missing metadata continues to mean unknown rather than absent.

### 5. Better failure and compatibility explanations — completed

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

Roadmap 5A establishes one shared generic contract for high-confidence source/acquisition failures used by both Preview and downloads. It distinguishes explicit request limiting, ambiguous access rejection, authentication, unavailable content, unsupported URLs, protected media, unavailable formats, thumbnail-extra rejection, and an unknown fallback without exposing raw tool diagnostics as the primary explanation. FFmpeg/local-processing and disk/filesystem classification remain a separate follow-up slice.

Roadmap 5B adds structured local-operation provenance at the failure boundary and uses it to distinguish missing required tools, permission failures, disk exhaustion, missing local files, explicit FFmpeg codec gaps, generic local processing failures, output-collection inconsistencies, and a neutral local fallback. The normalized four-field failure contract and History schema remain unchanged, and raw FFmpeg diagnostics or temporary paths are not promoted into primary UI copy.

### 6. Local edit staging — completed

LVOVD now provides the first public focused trim/stitch editor baseline while preserving normal Download as an independent path. The approved cross-roadmap product contract and boundary with Roadmap #7 remain documented in [`docs/local-media-workspace.md`](docs/local-media-workspace.md).

Established behavior:

- chosen/dropped local videos and eligible single, non-live URL Previews enter one temporary local-media workspace model;
- URL editor acquisition respects the selected source, profile, resolution, and Manual source choice, and is serialized with Preview/Download source work;
- the browser player, playhead, visual timeline, zoom/pan, exact fields, keyboard playback, and draggable/keyboard-adjustable handles share time-authoritative state;
- reversible outer Start/End bounds coexist with multiple middle removals and per-gap Restore actions;
- edited output concatenates retained ranges in source order and is a real high-quality H.264 MP4, with AAC when the source has audio;
- arbitrary authored boundaries deliberately use a local re-encode so the first release favors accurate editing semantics over a premature stream-copy fast path;
- compatible sources may play directly, while incompatible sources use a separate local playback proxy; the original workspace source remains final-render authority and is not modified;
- preparation and rendering support cancellation, while Discard, inactivity expiry, opaque workspace ownership, contained media endpoints, and localhost security bound temporary assets;
- normal Download remains independent; its Time Range and SponsorBlock behavior do not silently become editor cuts;
- Edit workspace activity and edited output are not persisted in durable Download History.

Future enhancements, not blockers for this completed baseline, include conservative/keyframe-aware stream-copy where it can be proven safe and sufficiently accurate, richer audio-track/subtitle preservation, and other evidence-driven playback or quality hardening. The **Edit -> Convert** handoff is implemented in Roadmap 7C below. Safe lossless operations remain a longer-term aspiration; the first release does not describe its re-encoded output as lossless.

The editing workspace remains a focused trim/stitch tool rather than a general-purpose nonlinear video editor.

### 7. Local media compatibility converter

Build a separate local-only utility for existing media files: a small codec/encoder workbench whose practical goal is **make this media work where I need it to work**.

Potential uses:

- inspect an existing file and explain its container/codecs before changing anything;
- remux compatible media without re-encoding;
- create editor- and Windows-friendly MP4 output;
- convert existing audio/video files to supported local formats;
- handle common Apple-origin compatibility problems such as MOV/HEVC-family media where the installed codecs permit it;
- convert modern image formats that cause compatibility friction, including AVIF/HEIC-style cases, to broadly usable formats such as PNG or JPEG where a suitable local decoder is available;
- support bounded local batch/queue conversion so a set of incompatible media can be normalized together;
- show local conversion progress, cancellation, and whether an operation is lossless/remux-only or requires re-encoding.

Capability discovery should inspect the **actual installed local conversion engine(s)** and expose only conversions that this installation can perform. FFmpeg is the natural primary engine because LVOVD already depends on it, but the product should not force every future image conversion through FFmpeg when a small, well-maintained local image library is demonstrably safer or more capable. No conversion path should require uploading the user's files to a cloud service.

**Roadmap 7A — inspection foundation:** introduced generic local inspection without an editor proxy, bounded discovery of installed FFmpeg capabilities, and truthful compatibility assessment. Its separate inspection-only intake is superseded by the shared 7B workflow below.

This feature should remain clearly separate from source acquisition: changing the requested local output format must not alter or multiply remote source requests.

**September 6 audit remediation — A3/A6:** the converter development line integrates the accepted master runtime/input-boundary, cleanup, and common-clock editing fixes from PRs #39/#40. Inspection distinguishes container brands from parser aliases, maps source codecs to advertised software decoder implementations, and preserves unknown metadata and reported stream presence. Capability discovery has command deadlines, bounded termination, successful process caching, and a short failure cooldown before a later request may retry; inability to check capabilities is distinct from a known missing requirement. Generated-media and Windows regressions cover these contracts, including shifted-source final-second editing.

**Roadmap 7B — unified Local Media and real outputs:** one upload and workspace support lazy Edit preparation and conversion of the original source to Compatible MP4, M4A/AAC, or MP3. A server-owned plan selects copy/encode per stream, authorizes existing bytes for complete no-ops, discloses omissions, and validates generated files before publication. Edit authoring state and separate edited/converted outputs survive view switches and failed/cancelled conversions. Required generated-media and Chromium tests exercise the actual workflow. Native AAC layout support is validated at runtime; an unverifiable 5.1(side) result is rejected.

**Roadmap 7C — Convert Edited File:** completed edited results can enter the existing converter locally, using their own inspection and an explicit original/edited input choice. Committed cuts must match the stored result plan; stale or replaced inputs require an updated render or explicit new selection. Shared output retirement preserves a no-op alias and opened downloads across editor rerenders, then removes unreferenced bytes with bounded cleanup retries. No extra upload, proxy-derived conversion, or provider acquisition is involved. Roadmap #7 remains incomplete: converted-result chains, Opus/FLAC/WAV conversion targets, batch work, images, and broader controls remain deferred.

**Roadmap 7D1 — unified local processing and compression:** Landon revised the product direction from 7B/7C's separate Edit/Convert navigation to one Local Media workbench: a single file's source/details/output controls on the left, player/timeline/trim controls on the right, and **Process File** as the finishing action. The accepted inspection, common-clock cuts, ownership, validation, and retirement remain; the main operation now applies committed cuts and encoding settings together directly to the original, with no intermediate lossy edited video. Defaults preserve the complete source; requested H.264 quality/bitrate/size or picture changes require encoding even for an H.264 source. Supported MP4/MOV/MKV containers and existing applicable M4A/AAC/MP3 output remain explicit choices. Aspect-preserving fit, no-upscale by default, frame-rate reduction, two-pass maximum-size budgeting, actual-byte validation, one bounded correction, and revisioned results are implemented. Reset File retains the source; Remove File uses owned Discard cleanup. The workbench uses a real one-entry Files list, compact encoding rows, bounded-width cut controls, and automatic original-source playback preparation on selection. Ordinary dimension/percentage scale presets show their actual fitted dimensions; linked bitrate/audio/size fields and honest size estimates explain the budget. A reviewed suffix control beside Process File names the result without relabelling previous downloads. This established the single-file foundation without a multi-file scheduler or persistent profiles.

**Roadmap 7D2 — multiple local files and Process All:** the Files list holds independent workspace/source identities, cuts, pending selections, playhead/zoom, output settings, revisions, and downloads. A bounded server-owned collection provides one browser progress connection and sequential original-source processing. Review All Files presents individual files/warnings before atomic queue admission; immutable queued snapshots survive newer drafts. Landon simplified Apply output settings to one checkbox for every output setting, including the suffix, while cuts and view remain individual. Sharing stays active until unchecked; Reset File disables sharing and stays scoped to the selected file. The stable, readable Files list and distinct green Process Selected File / blue Review All Files (count) actions clarify selection and scope. A light-mode toggle remains a later UI slice. Cancellation, expiry, removal, no-op bytes, and failed cleanup preserve per-file ownership and other successful results. The limits are 20 files per collection, two collections, 20 queued/running jobs, one upload per collection, and 100 GiB aggregate original-source reservations; additional temporary processing storage remains separately bounded. After a page reload, previous workbenches can be explicitly reopened or removed; retained cleanup remains reachable. No persistent profiles or queue recovery across server restarts are introduced.

**Roadmap 7D3 — playlist intake into Local Media:** after ordinary Preview, **Add Selected to Local Media (N)** admits a bounded selection of resolved video item URLs in Preview order. Acquisition choices are frozen independently of local output settings. The entire selection reserves collection slots before source work; each active item takes only the remaining source-byte allowance, including acquisition intermediates, and retains it through failed cleanup. One source coordinator serializes Preview, normal Download, single-URL intake, and playlist imports, with abortable courtesy pauses. Cancel Import, removal, expiry, or any intake failure prevent later requests while preserving completed and unrelated files/results. Imported sources join the existing settings-sharing, authoring, selected-only playback, and explicit Process Selected / All workflow through one aggregate progress connection. Import creates no final output, browser save, or History record. The existing collection/job/storage limits remain. Flat-playlist Manual formats and remote audio-only intake remain unsupported; local fixtures do not establish support for every external extractor.

**Next functional slices:** H.265/HEVC, VP9, AV1, and appropriate editing codecs such as ProRes remain future codec adapters. Images, hardware encoding, broader metadata/track controls, and desktop packaging are deferred. Roadmap #7 is not complete. 7B/7C remain the implementation history of the infrastructure and compatible APIs; their former navigation is superseded by the unified workbench.

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

### Mobile / phone use — exploratory

A native mobile application is not currently planned because LVOVD's filesystem, yt-dlp, and FFmpeg workflows fit a desktop utility much better. **Convenient phone/mobile use remains a longer-term product aspiration**, but the architecture is intentionally unresolved.

Any future mobile-access approach must preserve LVOVD's security and privacy model. In particular, do not casually expose the localhost server to the LAN or Internet merely to make phone access convenient.

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
- LVOVD should not add telemetry/profiling as a condition of normal use.
- Keep the default server bind local-only and do not weaken the loopback security model for convenience.
- Do not add DRM or access-control bypass behavior.
