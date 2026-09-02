# Local Media Workspace Product Contract

This document captures the approved product direction connecting Roadmap #6 **Local Edit Staging** and Roadmap #7 **Local Media Compatibility Converter**.

It is a product and architecture contract, not an implementation specification. Detailed mechanics may evolve during implementation, but changes should preserve the user-facing model and boundaries below unless a later product decision explicitly revises them.

## Core idea

LVOVD treats URL-acquired media and user-supplied local media as two ways to enter the same temporary **local media workspace**.

The workspace is not a permanent media library. It owns temporary working assets, local inspection/playback support, edit or conversion plans, local FFmpeg work, cancellation, prepared outputs, and cleanup.

Source acquisition, editing, and conversion remain understandable as distinct jobs even when they share this lower-level workspace.

The product should eventually support three clear workflows:

1. **Download from URL**
   - Preview and choose source/download settings as today.
   - Download normally, or choose to open the acquired media in Edit.

2. **Edit Media**
   - Start with media acquired from a URL, or provide an existing local media file.
   - Visually author trims/cuts.
   - Produce an edited output for download.
   - Optionally hand that edited local result directly into Convert as a second local step.

3. **Convert Media**
   - Start with an existing local file, an acquired source file, or a local edited result.
   - Change container/codec/compatibility as supported by the installed local conversion engines.
   - Produce a converted output for download.

A user should not have to download an intermediate edited result to the operating system and then upload it back into LVOVD merely to continue into Convert. Temporary local outputs may be handed directly between local workspace operations.

## Input sources

### URL-acquired media

Opening Edit from a URL workflow should acquire the selected source media once and then perform editing locally.

Opening the editor must not casually trigger a low-quality preview acquisition followed by a second full-quality provider acquisition. The selected media becomes the temporary working source for the editing session.

The existing normal Download path remains available and unchanged for users who do not want editing.

### User-supplied local media

Edit and Convert should also accept an existing local media file without requiring that it came from yt-dlp.

Because LVOVD currently runs as a browser UI over localhost, the browser cannot simply disclose an arbitrary filesystem path to the server. A file chosen or dropped into the browser will therefore need a safe local intake path into LVOVD's temporary workspace unless a future packaged desktop architecture provides a better direct-file mechanism.

This remains local processing: the file must not be uploaded to a cloud service.

The UI should be truthful if a large local file is being copied into LVOVD's temporary workspace and therefore temporarily consumes additional disk space.

## Temporary workspace semantics

A working source in Edit is temporary, not a permanent staged master.

For a URL-acquired Edit session, the expected model is:

1. acquire the selected source once;
2. place it in the temporary local media workspace;
3. edit from that local working source;
4. produce the requested edited output;
5. retain the working source only while the session/job requires it;
6. delete the working source when the session is discarded, cleared, or expires.

The same ownership/cleanup principle applies to user-supplied local files copied into the workspace.

LVOVD should continue to avoid claiming knowledge of the browser's eventual final save location.

## Editing is visual by definition

The editing experience must not be designed around typing timestamps into fields as the primary interaction. Exact fields are useful precision controls, but a usable editor requires a visual media player and timeline.

The editor should remain focused and intentionally smaller than a general nonlinear video editor.

### Preview player

The editing workspace should provide a small local video player with normal play/pause behavior, current time/duration, and seeking.

The player and timeline must share one authoritative playhead position.

### Timeline

The timeline is a core editor feature, not optional polish.

At minimum it should support:

- a visible playhead synchronized with playback;
- click-to-seek and/or scrubbing;
- visual start/end handles for a selected range;
- visual indication of retained and removed portions;
- multiple authored cuts, including removal and restoration of middle sections;
- clear review of the intended edit before processing.

The user should be able to understand what will remain and what will be removed without mentally translating a list of timecodes.

### Zoom and precision

Long videos cannot be edited precisely on a single fixed-width whole-duration timeline. The timeline therefore needs a concept of a **visible time window** independent of total media duration.

The user should be able to zoom into progressively smaller time ranges for finer cut placement. Zoom should remain understandable and should preferably preserve the area around the playhead or pointer rather than making the user repeatedly relocate the desired moment.

A two-hour video might begin with the whole duration visible, then allow zooming into minutes and eventually seconds around the desired edit point.

### Exact time controls

Exact numeric/timecode fields should exist alongside the visual controls for users who want precise values.

The visual timeline and exact fields must edit the same canonical state:

- dragging a handle updates the corresponding time field;
- editing a time field moves the corresponding handle;
- seeking changes the playhead but does not silently change the edit range;
- actions such as **Set Start to Playhead** and **Set End to Playhead** may provide useful direct control.

The product should avoid separate loosely synchronized sources of truth for timeline handles and time fields.

### Cut visualization

When a region is marked for removal, the timeline should visibly distinguish it through dimming, shading, hatching, or another clear treatment.

As multiple-cut support is added, the user should be able to see all removed and retained regions before rendering.

Representative frame thumbnails or an audio waveform may later improve navigation, but neither is required to establish the first functional visual timeline. The timeline model should avoid designs that make those layers impossible to add later.

## Edit-plan model

Internally, the editor should use a small validated timeline/edit-plan model rather than storing ad hoc UI coordinates.

Time values are authoritative; pixels are only a visualization of time within the current visible timeline window.

The model should be able to grow from one start/end selection into multiple non-overlapping keep/remove ranges without becoming a general NLE track system.

The browser should prevent or clearly reject invalid ranges, overlaps, negative times, reversed start/end values, and values outside known media duration.

## Processing and quality truth

The first public editing baseline produces a high-quality H.264 MP4, with AAC when the selected source has audio. It re-encodes locally so arbitrary authored boundaries can be honored closely, and leaves the workspace source unchanged. This output is not lossless and does not preserve arbitrary source codecs.

Conservative/keyframe-aware stream copy or remux remains a future optimization where it can be proven safe and sufficiently accurate. It is not a blocker for the first release. Timeline zoom and millisecond-level controls express precise edit intent; they do not imply frame-perfect or lossless processing.

## Browser playback and compatibility

The editor needs seekable local playback of the temporary working asset.

Compatible MP4/H.264/AAC media is likely to be straightforward in normal browsers, while Maximum Quality or user-supplied local files may contain containers/codecs that the browser cannot directly play.

The implementation design must therefore explicitly decide how playback works for incompatible staged media. A local playback proxy generated from the already-acquired/local source is acceptable if needed, but it must not cause another provider acquisition and should not replace the original working source used for final quality-sensitive processing.

Any local playback endpoint must remain confined to workspace-owned files and must not become an arbitrary filesystem read API.

## Relationship between Edit and Convert

Roadmap #6 and #7 should share local media workspace infrastructure where that reduces duplication, but they remain separate product jobs.

**Edit** answers: "What parts of this media should remain?"

**Convert** answers: "What format/codec/container should this media use?"

The eventual supported chains include:

- Edit -> download edited result;
- Edit -> Convert -> download converted edited result;
- Convert only -> download converted result.

Conversion controls should not clutter the normal editing timeline, and editing controls should not be required when the user simply wants compatibility conversion.

Roadmap #7 remains responsible for conversion capability discovery, codec/container choices, batch conversion, image compatibility work, and similar conversion-specific behavior.

### Implemented Roadmap 7A boundary

The shared workspace now has a bounded server-owned purpose of `edit` or `convert`. Both purposes reuse opaque ownership, streamed local intake, the 100 GiB limit, cancellation, Discard, inactivity expiry, and contained cleanup. URL acquisition remains Edit-only.

Generic local inspection can describe timed video, audio-only media, and conservative unsupported/unknown input without equating all media with editable video. Edit applies its existing stricter timed-video validation and direct-playback/proxy preparation after that generic probe, preserving its current behavior. Convert inspection accepts one local video or audio source, never creates a playback proxy, and keeps the original source inside its workspace.

Roadmap 7A also performs process-lifetime cached, bounded discovery of the FFmpeg installed on `PATH` and uses normalized encoder, decoder, and muxer facts to assess the initial **Broad Compatibility MP4** video target. Raw FFmpeg listings and local paths are not browser data. The visible workflow is explicitly inspection-only; it creates no converted output, makes no provider request, and does not add workspace activity to Download History.

## Existing Custom Range and chapters

LVOVD already has a quick Custom Range / chapter download path that uses yt-dlp download-section behavior.

That existing working feature should not automatically become the new visual editor architecture.

A later product/implementation decision may choose to keep it as a fast advanced download option, seed an Edit plan from it, or migrate some behavior onto shared local editing machinery. Do not remove or rewrite it merely because the visual editor exists.

## SponsorBlock boundary

User-authored cuts and SponsorBlock remain separate features.

They may eventually share local segment-processing machinery, but selecting or creating user cuts must not silently enable SponsorBlock, and SponsorBlock must remain optional/off by default unless the user explicitly chooses otherwise.

## History

The visible durable feature remains **Download History**. Edit workspace activity and edited outputs are not currently persisted there. The history schema does not store workspace IDs, temporary source paths, playback proxies, edited-output paths, or browser save paths.

Any future edited/converted-result history requires its own stable product and schema decision rather than leaking temporary workspace state into Download History.

## Implemented Roadmap #6 baseline

Roadmap #6 now implements the first focused editor release across its accepted slices:

- **6A1 — workspace and visual timeline:** one chosen/dropped local video is copied into an opaque temporary workspace, inspected locally, and played directly or through a separate playback proxy; the browser provides a synchronized player/playhead, zoomable and pannable timeline, exact fields, reversible outer bounds, cancellation, Discard, inactivity expiry, and contained workspace media access;
- **6B — real edited output:** changed plans can produce and download a locally rendered H.264 MP4 with AAC when audio exists, with streamed progress, cancellation/retry, post-render validation, stale-output detection, and atomic successful replacement;
- **6C — multiple cuts:** the canonical version-1 keep-range plan supports sorted retained ranges, middle-section removal and Restore, generic retained/removed timeline rendering, and bounded multi-segment FFmpeg concatenation in chronological order;
- **6A2 — URL Preview to Edit:** an eligible single, non-live Preview can use **Edit Source Video** to acquire the selected source/profile/resolution or Manual source choice once into the same workspace, serialized with Preview and Download source work and without changing normal Download or durable History.

The original workspace source remains final-render authority; a playback proxy is never the render source. Download Time Range and SponsorBlock remain separate Download behavior and do not silently seed editor cuts.

Remaining deferred work includes conservative/keyframe-aware stream-copy optimization, richer track/subtitle preservation, evidence-driven playback and quality hardening, and the Roadmap #7 **Edit -> Convert** handoff. These are future enhancements, not missing requirements for the completed first editing baseline.

## Boundaries that remain in force

Do not use this feature as justification to add:

- a permanent media library or database by default;
- cloud upload/storage;
- telemetry;
- a general nonlinear editing system;
- provider-specific editing behavior;
- parallel source acquisition;
- authentication/cookie support;
- DRM/access-control bypass;
- proxy/block-evasion behavior;
- casual LAN/Internet exposure of the localhost server.

LVOVD remains local-first, not anonymous. URL source services still see the user's acquisition requests; local editing and conversion happen after that acquisition and should not multiply those source requests merely because the user opens an editor or changes a local output decision.
