# Local Media Workspace Product Contract

This document captures the approved product direction connecting Roadmap #6 **Local Edit Staging** and Roadmap #7 **Local Media Compatibility Converter**.

It is a product and architecture contract, not an implementation specification. Detailed mechanics may evolve during implementation, but changes should preserve the user-facing model and boundaries below unless a later product decision explicitly revises them.

## Core idea

LVOVD treats URL-acquired media and user-supplied local media as two ways to enter the same temporary **local media workspace**.

The workspace is not a permanent media library. It owns temporary working assets, local inspection/playback support, edit or conversion plans, local FFmpeg work, cancellation, prepared outputs, and cleanup.

Source acquisition, editing, and conversion remain understandable as distinct jobs even when they share this lower-level workspace.

The original 7B/7C product direction separated three workflows (the 7D1 revision below supersedes their separate Edit/Convert navigation):

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

The pre-7D1 contract kept editing and conversion as separate product jobs sharing local workspace infrastructure. The distinction below still describes intent; the unified screen now applies both in one direct processing operation.

**Edit** answers: "What parts of this media should remain?"

**Convert** answers: "What format/codec/container should this media use?"

The eventual supported chains include:

- Edit -> download edited result;
- Edit -> Convert -> download converted edited result;
- Convert only -> download converted result.

Conversion settings sit beside the editing timeline in 7D1. Editing remains optional for users who only need compatibility conversion.

Roadmap #7 remains responsible for conversion capability discovery, codec/container choices, batch conversion, image compatibility work, and similar conversion-specific behavior.

### Implemented Roadmap 7B/7C history and compatible operation boundary

7B/7C introduced one neutral local intake that streams a source into an opaque workspace, performs protected generic inspection, and offered Edit/Convert plus expandable Media Details. The old intake routes remain thin adapters. URL acquisition acquires only once; the resulting original source can also be processed without another provider request. The following explicit edited-result handoff remains compatible internally; it is no longer required by the main interface.

Generic source inspection is the authoritative evidence. Explicit server validation prepares Edit lazily and derives its stricter video projection. A playback failure retains a valid source for Convert. Editor preparation, authored cuts, playhead, zoom/pan, pending cut, and separate edited/converted outputs survive switching views. One browser coordinator owns intake, workspace identity, EventSource/lease, and Discard; leaving Edit pauses playback.

Convert names the explicitly selected input and its duration: original source or latest eligible edited result. **Convert Edited File** on the completed editor card hands that exact local asset to the existing converter. **Use Original Source** explicitly switches back; view changes preserve selection. A replaced edited input remains identified as the prior selection until the user selects the updated result. No intermediate browser download/upload, automatic render, or provider acquisition occurs.

Edited handoff requires the current committed canonical edit plan to equal the validated asset's stored plan. Changed cuts disable handoff with “Create an updated edited file first” while preserving the previous download. Pending uncommitted selections are not applied. The browser exposes a read-only copy of current plan/eligibility to its coordinator and invalidates pending edited-input review when freshness changes; completed converted downloads remain valid. At plan/Start the client submits that canonical assertion, normalized against the **original source duration**, since keep ranges still use original-source coordinates. The server verifies the assertion and registry identity, not unsubmitted browser intent; no continuous handle synchronization is introduced.

Conversion requests use `inputAssetId`; the registry determines its role. New planning/Start accepts only the owning original source or latest validated edited output, and rejects proxies, converted-result chains, retired results, and cross-workspace inputs. Original Edit preparation retains a separate original-only resolver, and rendering remains tied to that source. Edited conversion reuses its actual stored output inspection, never original/proxy metadata. Keys bind workspace/input identity, role, inspection evidence, edited-plan identity, target, and effective settings/warnings; asynchronous discovery/stat boundaries revalidate before admission. A pending plan reserves no file. Admitted conversion owns its exact input until termination/completion. Converted output retains bounded input ID/role/name/duration and edited-plan provenance; filenames derive from the input. Later editor results cannot relabel that output. Known omissions still require acknowledgement; paths, mappings, filters, and encoder names remain server-owned.

Successful capability discovery is cached for the process. Each listing command has a five-second deadline and bounded termination; failed checks settle with unknown capability evidence and are cached for a 30-second cooldown before another request may retry. Discard cancels only that workspace's wait. Assessment distinguishes actual container identity, codec-to-software-decoder evidence, and incomplete stream metadata; a known missing capability is different from a failed check. Generic inspection and the Edit adapter retain the same source origin and selected-stream endpoint duration used by the corrected editor.

The three targets are Compatible MP4 (H.264/yuv420p, AAC when source audio exists), audio-only M4A/AAC, and mono/stereo MP3. Suitable streams are copied independently; complete container/role/inventory matches authorize a secure download of existing source bytes without a disk duplicate or encoder work. Other matches remux only the selected streams. Newly encoded video uses libx264 CRF 18, medium, yuv420p, faststart, source cadence, and minimal even-dimension padding. AAC uses native encoding at 128 kbps mono, 256 kbps stereo, or 512 kbps for 5.1/5.1(side); MP3 uses libmp3lame quality 0. Encoding retains 44.1/48 kHz or discloses resampling to 48 kHz. Copy retains actual source parameters, including low-bitrate AAC. Unsupported multichannel paths never silently downmix.

Video conversion uses one source presentation origin and preserves relative A/V delay, internal gaps, and selected endpoints, including audio beyond the video endpoint. Audio extraction shifts the selected audio timeline to zero and preserves internal gaps without padding a video-only tail. Timestamped MP3 from another container is encoded with silence for gaps because bare MP3 cannot represent those packet timestamps; this transformation is disclosed. Missing endpoint evidence can make an extraction plan incomplete. No full-output decoding is added to normal completion: bounded inspection validates container, exact roles, codecs, geometry/orientation, audio parameters, duration, and available selected endpoints. Audio timing tolerance is 60 ms for AAC/MP3 priming and muxer rounding; video allows the larger of 60 ms or one frame plus 10 ms. Tiny tests decode markers separately.

Copied video retains standard display rotation; encoded video applies supported 0/90/180/270 rotation once. Known HDR, alpha, and unsupported transforms are refused for the video target; audio extraction can remain available. Missing metadata stays unknown. Arbitrary metadata and alternate-stream preservation are not promised, and files are not advertised as privacy-scrubbed. Capability listings do not guarantee every encoder result: some native AAC builds return six channels with an unnamed layout for 5.1(side). Validation rejects that result rather than assuming speaker positions or publishing it as successful.

One conversion slot exists across the Node process, with one expensive operation per workspace and no batch queue. This does not serialize existing Download/Edit work in other workspaces. Cancel acknowledges within a bounded interval; the slot stays reserved until process exit is observed. Failed/cancelled reruns preserve previous successful outputs. New attempts use unique files and validate before publication.

Shared output retirement checks explicit owners: latest edited result, admitted conversion input, latest successful conversion result (including a no-op alias), and already-open downloads identified by asset ID. New ownership is published before old ownership is released. Thus edited A → Compatible MP4 can use A's unchanged bytes; rendering B changes the editor's download while the converter still serves A. A retires only after that alias is replaced and its last opened reader closes. Separately generated conversions retain provenance without pinning their old input forever. Repeated no-ops never delete their own asset, and unreferenced rerender versions do not accumulate.

Replacement revokes obsolete download/planning authorization while allowing existing readers to finish; last-reader close triggers pending retirement. File deletion failures keep a small path-owning retirement record and the existing bounded retry budget. Unresolved deletion blocks additional render/conversion admission until explicit temporary cleanup succeeds; still-referenced aliases/readers remain usable. Discard/expiry immediately invalidate all IDs, cancel processing, close readers, and transfer remaining bytes to retained directory-cleanup ownership after safe release. This is in-memory lifetime management, not persistent crash recovery.

Inputs and converted outputs each have a 100 GiB cap, with active and final output enforcement. A tool size limit cannot publish a truncated success. Disk use can simultaneously include the source, playback proxy, latest edited result, a retained older no-op input/opened download, previous conversion, new attempt, and cleanup-pending files; free space is not guaranteed. ENOSPC is a local failure. These temporary operations do not create Download jobs or History entries. Later targets (including Opus/FLAC/WAV), converted-result chains, batches, and images remain deferred.

## Roadmap 7D1 product revision — one workbench and direct processing

Landon explicitly replaced separate Edit/Convert navigation with the supplied unified-workbench direction: file/source details and output settings on the left, the selected video's player/timeline and **Trim Video Length** tools on the right, and one prominent **Process File** action with its final download. 7D1 accepts exactly one file; extra dropped files are rejected rather than silently ignored. There are no fake batch controls. Media Details stays expandable, audio-only input needs no video editor, and the URL downloader remains first and independent.

The authoritative operation is **original workspace source + canonical committed keepRanges + requested output settings → final output**. A server-built reviewed plan binds workspace/source identity, selected stream indexes, source inspection, original-coordinate cuts, normalized settings, and draft revision. It never accepts client paths or FFmpeg arguments. The plan applies cuts and encoding together; both passes of a two-pass operation read the same original with identical video cuts/transforms. No intermediate lossy edited file or playback proxy becomes output authority. Current common-clock mapping, leading silence, internal gaps, chronological frame order, source origin, and frame/sample tolerances remain in force. Video cuts can also produce M4A/MP3 directly; audio-only files retain full selected-audio conversion without adding an audio editor.

Defaults are unchanged video codec/container/scale/cadence/audio and automatic rate. A complete no-op authorizes all original bytes, including their existing inventory; it does not need a working encoder. Bounded capability discovery supplies available controls. Explicit compatible container-only changes remux selected streams. Changed operations keep the established omission review. “Unchanged codec” preserves codec identity where an implemented encoder supports the requested transform; it does not promise losslessness. Cuts, scale, quality, bitrate, or size changes require encoding even for H.264 input. If that requires an unsupported video/audio encoder or muxing combination, the plan requires an explicit supported choice, without silently substituting codecs, removing audio, or downmixing.

The initial video adapter is software H.264/libx264. MP4, MOV/QuickTime, and Matroska/MKV are available where inspection, policy, and installed capabilities permit; Keep source is supported for implemented containers, or unchanged existing-byte downloads. M4A/AAC and MP3 preserve their established audio conversion policy. Known HDR/alpha and unsupported transforms/channel layouts stay conservative, including the documented native AAC `5.1(side)` validation limitation.

Rate modes are mutually exclusive: **Automatic** copies where the whole operation permits, otherwise discloses CRF 18/medium for required H.264 encoding; **Quality** selects bounded CRF and software speed with variable final size; **Average bitrate** uses a positive bounded video bitrate with optional two passes and a size estimate when audio evidence permits; **Maximum file size** uses decimal MB (1 MB = 1,000,000 bytes) per complete output. Size budgeting uses retained duration after cuts, encoded audio bitrate or inspected copied-audio evidence with reserve, and fixed/per-packet/variable container overhead. Missing audio budget evidence requires an explicit supported audio encoding bitrate. Nonpositive or too-small video budgets are refused; arbitrary tiny sizes carry no visual-quality promise.

Maximum size uses two-pass H.264 and measures actual complete bytes before publication. At most one additional two-pass attempt may lower only the planned video bitrate, with a disclosed correction phase. If still oversized or the corrected budget is impossible, it fails and retains the previous result. No `-fs` truncation stands in for fitting a file. The independent 100 GiB output safety cap remains active; it is not a successful-output target. Resolution, channel count, and selected audio cannot change merely to fit a byte target.

Scale is unchanged or an aspect-preserving fit inside bounded width/height, with no-upscale enabled by default. Ordinary presets range from 320×180 to 4096×2160, with width-only, height-only, 50%/25%, and custom fit choices. The server resolves those requests from the oriented source geometry; the other dimension follows display aspect, and scaled coded dimensions are bounded to 16384 per side. Resolved coded dimensions and display aspect are reviewed before processing and labelled “adjusted to fit aspect”; 390×520 inside 854×480 resolves to 360×480. Standard source orientation is applied once when encoding; even dimensions use scaling/padding without cropping source pixels. Frame rate is unchanged or explicitly reduced without changing playback duration. AI scaling, spatial crop, arbitrary stretching, tone mapping, and new rotation/mirror controls are deferred.

The compact compression controls show video bitrate, audio bitrate, and file size together. Editing video bitrate selects average-bitrate intent and recalculates estimated size; editing size selects maximum-size intent and recalculates video budget. Changing audio or committed cuts recomputes the dependent values. Auto and Quality remain explicit alternatives, not simultaneous bitrate/size constraints. Review includes an exact source-byte size for no-ops, estimates from defensible stream-rate/remux evidence where available, and an explicit variable/unknown size for CRF, MP3 VBR, or missing rate evidence. Estimates do not trigger trial encoding or repeated probing. Source inspection retains a bounded video bitrate fact alongside the existing audio bitrate. Only completed-byte validation proves a maximum-size result fits.

The suffix control beside Process File is part of canonical settings and the reviewed plan key. The server accepts at most 60 filename-safe suffix characters, constructs the download name itself, and retains it with the admitted result. The default is `-processed`; disabling the control submits an empty suffix. Naming applies to generated and byte-identical no-op downloads; it never changes physical source/attempt paths or requires encoding. Later suffix changes mark a new draft, preserve the previous result name, and reset with Reset File.

Field help is available by hover, keyboard focus, or click/tap, with Escape/outside dismissal and placement bounded to the viewport. It explains the controlling value, CRF versus bitrate, suggested trial ranges, and one/two-pass tradeoffs without changing the draft. Estimates include conservative reserves and are not exact-size promises; single-pass average bitrate can undershoot. Processing review, reserve, and result sizes use decimal MB (1,000,000 bytes), and completed results also show exact bytes and the stored inspected average video bitrate when present. These are display facts; no additional probing or changes to rate control/admission are introduced.

One bounded in-memory file profile holds stable workspace/source identity, source facts, reversible committed cuts, pending cut/playhead/zoom/pan, requested settings, draft revision, submitted snapshot, and latest successful result with provenance. Control changes invalidate older reviews and create a new draft; they cannot mutate admitted processing or relabel a completed result. The browser owns unsubmitted authoring state and uses no continuous server synchronization of handle movement. The server rejects older submitted revisions, conflicting same-revision intent, and changed plan/source evidence after asynchronous boundaries. There is no automatic processing when a control changes.

The compact **Files** list contains the actual selected entry, with one-file intake still enforced. Codec/output and scale controls share compact rows; Auto, Quality, Bitrate, and File size are explicit compression choices. Selecting a video automatically prepares seekable playback once from the original workspace source, using direct playback when compatible and the existing local proxy only when necessary. Settings changes and reselection do not regenerate playback. A failed preparation exposes **Retry Preview**. Preview failure does not automatically prevent valid processing from the source. **Reset File** confirms lost authored work, resets cuts/settings, and retains the original and correctly labelled previous output; **Reset Range** keeps its narrow timeline meaning. **Remove File** confirms relevant authored/running/prepared work and uses existing Discard invalidation and truthful cleanup. A conditional `beforeunload` warning is best-effort only, with no guaranteed/custom browser text and no reliance on unloading to delete server files.

Processing uses the converter's existing process-wide slot and one expensive operation per workspace. Ownership covers all passes, validation, and the optional correction. Cancel stops the owned current phase, prevents later phases, and holds admission until actual termination. Unique attempt directories own partial files and pass logs; failed bounded removal retains those directories and blocks further file creation until explicit retry. Final publication validates before replacing the prior result and reuses #43 retirement/no-op/reader ownership. Discard/expiry invalidate first, cancel/close resources, and transfer remaining paths to retained cleanup ownership. Temporary storage may simultaneously contain the original, optional proxy, previous/new result, pass logs, correction attempt, and cleanup-pending data. No durable per-file database, crash recovery, Download job, or History entry is introduced.

The interface reports preparation/pass/encoding/validation phases and phase progress; optional corrective work uses indeterminate overall progress rather than a fabricated estimate. Review shows source/retained durations, codecs/container, resolved dimensions, rate/size/audio treatment. Results show their actual inspected duration/geometry/codecs, completed bytes, revision/settings, and Download.

7D1 established single-file unified H.264 processing with applicable audio outputs. The 7D2 extension below makes the Files list functional for multiple local files while retaining that processing model. The 7D3 extension below adds playlist intake. H.265/VP9/AV1/ProRes adapters, images, hardware encoding, broader metadata/track controls, and desktop packaging remain subsequent work. Roadmap 7 remains incomplete.

## Roadmap 7D2 — independent local files and a sequential queue

Each Files entry owns an existing workspace/source identity, immutable source facts, its own reversible authoring and canonical committed cuts, pending selection, playhead/zoom/pan, output settings/suffix, draft revision, submitted snapshot, and latest successful result. Selecting an entry restores copies of its state and prepares only that selected video's playback when needed. Audio files need no video editor. Selection, output changes, and queue operations never upload again or request provider media. An eligible existing URL editor workspace may enter the same collection without another acquisition; playlist intake is supplied by 7D3 below.

An opaque server-owned collection groups these workspaces. One bounded EventSource supplies collection snapshots with authoritative per-workspace progress and queue status. Monotonic snapshot revisions prevent older HTTP responses from replacing newer progress or removing newly added entries. Late preview, plan, upload, and removal responses remain scoped to their owning entry/generation. The shared editor/player does not become an authority for another file's source or cuts.

Process Selected File submits the selected reviewed draft. Its ready heading reads “Ready to process selected file”; submitted/result revisions remain available when relevant. Review All Files shows the total current file count in parentheses and builds an explicit per-file review, with omission acknowledgements and selectable eligible entries. **Queue And Process** admits those reviewed files. Missing/unsupported sources are explained and excluded; files already queued/running or already successfully processed at the same revision are excluded from batch selection. An unchanged eligible source uses the complete original bytes. The shared Local processing queue lists status and each file's latest successful Download without changing the selected editor. Previous results remain identified and downloadable after a failed or cancelled replacement. There is no automatic processing, downloading, or retry when settings change or a job fails.

Landon revised Apply output settings to all to one all-or-nothing checkbox, enabled by default for a fresh workbench: checking it copies every output setting (video codec/container, picture scale/cadence, compression, audio, and suffix). While checked, subsequent output-setting changes and newly inspected files use the shared settings. Selection and progress updates do not copy settings. Unchecking stops future copying without reverting drafts; Reset File turns sharing off before resetting only the selected file. Cuts, pending selections, playhead, and zoom are never copied. Every file is revalidated against its own inspection. Unsupported combinations remain requested and need correction rather than silently selecting H.264, dropping audio, or downmixing. Applying settings can create a newer draft even while an older snapshot is queued/running; existing results keep their submitted provenance and name.

Queue admission validates collection membership, exact workspace/source identity, canonical original-coordinate cuts, revision, plan key, settings, required acknowledgements, and source/inspection evidence. It rechecks after asynchronous discovery/stat and admits the selected set atomically. Duplicate or conflicting submissions fail without adding partial jobs. Admission pins a copied, frozen reviewed plan and the original source. Execution rechecks source identity immediately before processing; later browser reviews do not rewrite queued snapshots. Direct legacy processing/rendering cannot bypass ownership while that file is queued. There is one process-wide conversion/processing slot, with the existing one-operation-per-workspace guard. Every pass, validation, and corrective attempt uses the original and keeps the slot until completion or confirmed cancellation.

The queue shows queued, checking/starting, running/cancelling, completed, failed, and cancelled states with per-file progress and overall counts, without a fabricated batch ETA. Cancel File removes waiting work or cancels that entry's active processing. Cancel All invalidates pending admission and marks all waiting jobs before requesting active termination, preventing a following start during cancellation. Ordinary failure is isolated to its entry and does not remove successful outputs. Successful replacement, opened readers, original no-op aliases, retirement, and bounded cleanup continue through the existing workspace machinery.

Aggregate progress coalesces actual updates while the HTTP buffer is full. A drain notification only releases transport capacity; it does not manufacture another state update. Even a snapshot larger than the buffer settles when the processing state stops changing. Reopening uses the same rule, and another file's progress does not rebuild the selected timeline.

Reset File affects only the selected draft and reversible authoring; it retains its original and previous result and does not mutate its queued snapshot. Remove File immediately invalidates that entry, cancels/removes its work, closes its readers, and transfers deletion to retained cleanup ownership. Other entries remain usable. Progress heartbeats touch live members; queued jobs have an absolute one-hour waiting limit so they cannot pin a source indefinitely. Expiring waiting work releases its queue ownership and leaves the source available for explicit review under ordinary inactivity expiry. Active work retains ownership until safely terminated. Cleanup retries stay bounded, and unresolved removed-source cleanup retains its byte/count reservation.

Server limits: two collections, 20 entries per collection, one upload per collection, 20 queued/running jobs across the manager, and 100 GiB aggregate original-source reservations across collection-managed workspaces. Existing standalone API workspaces retain their separate per-workspace caps. Collection uploads require a finite positive Content-Length and cannot exceed their reservation. Single-URL attachment reserves the existing source cap until an authoritative size is known; the bounded 7D3 import uses the remaining source allowance described below. Failed cleanup consumes both byte and file-count capacity; repeated tiny failures cannot grow an unlimited directory list. Sources, each processed output, and other workspace operations retain their existing caps and retirement backpressure. The 100 GiB source reservation is not a bound on total simultaneous disk use: optional proxies, successful/prior results, attempt files, pass logs, and cleanup-pending data can coexist. ENOSPC remains a local failure with preserved ownership, not a reason to delete another file's result.

Collections, file profiles, and queue state are in memory. There is no persistent queue, crash recovery, database, asset graph, new worker/service, or Download History entry. Reloading does not restore unsent authoring. Previous local workbenches are listed through the protected local API, bounded by the existing two-collection limit. Reopen restores the existing source/result identities and queue, with fresh default authoring above the last server-reviewed revision; it does not acquire sources again. Workbenches connected to another tab cannot be reopened or removed through this recovery action. Explicit Remove workbench invalidates its assets and cancels owned work, but retains its collection/byte/count ownership while resources or deletion remain pending. Failed cleanup can be reopened and retried locally even after another refresh. No files are deleted merely because a page reloads. Existing Host/Origin/Fetch-Metadata checks, opaque assets, shared local-input restrictions, shell:false, common-clock timing, size validation, and the documented AAC 5.1(side) limitation remain unchanged.

## Roadmap 7D3 — explicit playlist source intake

Ordinary playlist Preview and item selection now offer **Add Selected to Local Media (N)**. This appends sources to the same Files collection, then leaves final processing to **Process Selected File** or **Review All Files**. It does not create Download jobs/History, browser saves, intermediate uploads, or automatic final processing. The original single-URL editor action remains available.

The server retains at most four bounded playlist Preview snapshots for ten minutes. Admission validates a selected set of resolved item page URLs against that evidence, deduplicates it, and freezes Preview order, identities, bounded titles, and acquisition choices. An unresolved or known live/protected/ineligible item is rejected before the selected set starts. Flat metadata remains unknown where absent; there are no eager per-item capability probes. Video + Audio and Video Only use the existing Compatible MP4 / Maximum Quality profile and resolution limit. Remote audio-only intake and flat-playlist Manual format IDs are unsupported. Download ranges, chapters, extras, SponsorBlock, local cuts, and local encoding settings do not enter the acquisition contract.

There is one live import per collection and one retained request identity for bounded duplicate admission. All selected entry slots are reserved atomically within the existing 20-entry limit, including other files and failed-cleanup ownership. Waiting descriptors have no directory or source asset. Immediately before each acquisition, a fixed positive allowance is reserved from the remaining shared 100 GiB source budget, capped by the per-source limit. It remains owned through asynchronous workspace creation, acquisition, and inspection. Actual partial files, separately downloaded streams, and merge intermediates are measured; metadata estimates and yt-dlp's size option are not the sole guard. Successful adoption and intermediate cleanup reduce the allowance to retained source bytes. Failed deletion retains ownership and capacity until existing bounded cleanup completes. This source budget does not include all simultaneous proxy/output/processing storage.

One task in the shared source coordinator runs the selected items sequentially, with the existing randomized, abortable courtesy pause between them. It calls the actual acquisition operation directly, without nested coordinator admission or parent-playlist expansion. Managed yt-dlp isolation, no-playlist/non-live filtering, selected stream policy, local inspection restrictions, and shell:false remain. Acquisition has no automatic source retries. Cancellation terminates the owned acquisition process tree/group and retains ownership until child pipes close; it cannot release capacity merely because a launcher was signalled.

One aggregate EventSource reports intake independently of processing: waiting, acquiring, inspecting, ready, failed, or cancelled/not started. Arrivals retain the current selection. Existing sharing is on by default; a source inherits the shared output settings when inspection makes its profile available. Sharing off creates independent defaults. Cuts, pending selections, playhead/zoom, queued snapshots, and previous downloads remain per-file. Playback prepares only the selected inspected original; a later proxy failure retains that source and its Retry action. PR #47's per-entry progress/request guards also protect playlist entries.

**Cancel Import** stops active acquisition and all later items, keeping completed imports and unrelated sources/results. **Remove File** invalidates a pending or acquiring identity before late work can publish and stops the rest of its import. Any source or intake-inspection failure stops remaining requests, including rate/access/authentication, disk, and unknown failures. A new explicit import is required to try source intake again. Processing Cancel All remains scoped to processing. Collection removal and expiry cancel owned intake, invalidate assets, and preserve failed cleanup for retry; there is no persistent import recovery.

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

Remaining deferred work includes conservative/keyframe-aware stream-copy optimization, richer track/subtitle preservation, and evidence-driven playback and quality hardening. These are future enhancements, not missing requirements for the completed first editing baseline. Roadmap 7C now supplies the local **Edit -> Convert** handoff described above.

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
