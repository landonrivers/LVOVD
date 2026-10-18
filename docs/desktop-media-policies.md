# v3.0 desktop migration — 8B (in progress)

Stage 8B continues from the [8A staging merge](https://github.com/landonrivers/LVOVD/pull/52) on `staging/v3-desktop`. Its PR targets staging; `master` remains the released v2.7 application. This document records partial implementation, not stage acceptance or release readiness. Follow the [development contract](development-contract.md) and [8A setup and platform evidence](desktop-foundation.md).

The [feature parity register](v3-feature-parity.md) maps every audited v2.7 capability and accepted desktop addition to its native workflow and migration stage. Core policy entries can be Ported; no completed user workflow is claimed Verified. CI validates register/test references, prevents silent inventory loss against prior revisions, and blocks stable-version acceptance while any required entry remains incomplete. This is migration tracking, not implementation of the missing Download or Local Media operations.

## Implemented first

The Rust core now contains audio policy, retained-range normalization, media inspection, FFmpeg capability discovery, processing settings, reviewed processing/conversion plans, argument construction, output validation and owned worker supervision. Policy and normalization remain separate from tool execution. Native intake uses the new inspection facts; the planner consumes capability facts without adding discovery to the short runtime-health probe. The desktop preview still exposes the 8A workflow; processing and Download operations are not yet connected.

- Audio precision remains unknown when the source evidence is insufficient. FLAC requires proven integer precision through 24 bits, preserves sample rate/layout, and retains actionable WAV guidance. WAV chooses a preserving integer or floating-point representation. Opus uses the existing channel/layout and bitrate restrictions. AAC/MP3 retain the released decisions.
- Audio-only timelines use the selected stream's start and endpoint; video retains the common media clock. The generated Rust processing tests below exercise these decisions separately from the future editor playback adapter.
- Version 1 retained ranges validate raw bounds, ordering and overlap before millisecond rounding. Adjacent rounded ranges merge. The 50-range limit, no-op rejection, error messages and retained duration match the reference.
- Normalized edit plans own their ranges and expose read-only access. Mutating a request afterward cannot change the normalized plan. Full queued-job immutability remains part of later operation integration.

`test/fixtures/desktop-policy-v1.json` holds 170 synthetic cases with expected outputs from v2.7.0 (`7e192ad`). The JavaScript reference and Rust tests independently read the same corpus. It covers integer/float/unknown precision, conflicting evidence, supported and unsupported layouts, missing metadata, bitrate edges, resampling decisions, audio clocks and retained-range validation. Rust also rejects non-finite internal arguments that cannot arrive as JSON numbers.

`test/fixtures/desktop-inspection-v1.json` adds 75 shared cases for container brand evidence, stream selection, cover art, timing origins/endpoints, Matroska duration tags, orientation/display matrices, HDR/alpha evidence, precision, frame rates, capability aliases and hardware-only decoders. Generated 16/24/32-bit integer and 32/64-bit floating-point WAV files at several sample rates, plus shifted MP4/MKV sources, are inspected by both implementations and compared. Live local FFmpeg listings are also compared with the reference parser; these tests do not contact media providers.

Inspection captures at most 4 MiB and 64 streams, limits chapters to 10,000, and keeps the reference's bounded text, format-name and side-data handling. Malformed stream objects and oversized payloads fail closed. Selected metadata omits filenames, arbitrary tags and raw diagnostics. The legacy playback descriptor stays available with additive `media` facts; attached artwork no longer selects a video MIME type for an audio source. FFprobe retains the local-only demuxer/protocol policy and now rejects an external-track warning even after a successful exit. Real MOV reference and playlist tests check this boundary and preserve original files.

Capability discovery runs only version/encoder/decoder/muxer listings against an explicit executable path, with a five-second deadline per command and a shared 4 MiB stdout/stderr ceiling. Parsing limits listings to 10,000 lines of at most 4,096 UTF-16 units each. Concurrent requests reuse one discovery; success is cached for that tool instance, failure retries after 30 seconds, and cancellation is not cached. Software decoder selection uses explicit listing aliases and excludes hardware implementations. No missing encoder or muxer is invented. Tests exercise missing/failing tools, malformed/oversized output, deadlines, cancellation, concurrent reuse, failure cooldown and redacted errors.

### Settings and reviewed plans

The planner preserves the version 1 settings contract, validation order and messages, inactive-control normalization, reviewed filenames, source identities and revisions. It uses the inspection and capability libraries for original-file no-ops, supported remux decisions, H.264 quality/bitrate/size modes, geometry, cadence, audio policies, omissions and required warnings. Untouched originals bypass encoding restrictions and unavailable encoders. Maximum-size plans retain decimal MB, the copied-audio reserve, container overhead and two-pass requirements; encoded FLAC still cannot supply an honest size budget.

Legacy Compatible MP4, M4A/AAC and MP3 conversion plans remain a separate policy path, including edited-input identities, full-file AAC/MP3 delegation, timestamped MP3 handling and existing no-op decisions. This Local Media conversion policy is not the ordinary Download conversion policy; the latter still belongs to 8D.

`test/fixtures/desktop-processing-v1.json` contains 595 cases generated from the unchanged released planning, command and validation modules: 338 settings/plan/name decisions, 128 argument arrays and 129 output-validation cases. Together with the other corpora, 840 shared cases compare Rust with the reference. Both implementations compare every plan field, option, estimate, timing decision and failure except the two opaque hash strings. Rust separately tests stable review keys, stale-key rejection, binding to workbench/source/name/revision/settings/inspection/capabilities, inactive controls and independent ownership. Its SHA-256 keys use canonical sorted JSON and therefore differ from JavaScript's insertion-order JSON hashes. They remain session-local review identities, never cross-backend or persisted queue IDs; no request field, plan version or media decision changes.

The core accepts authoritative inspection and capability facts from its Rust caller. `ReviewedPlan` owns a private document, exposes read-only access, and cannot be deserialized from frontend JSON. A public projection hides decoder/encoder details. **This is not yet native admission:** the future operation must look up owned inputs, re-inspect/review as required and compare the supplied key before starting a worker.

### Arguments, validation and real media

`processing_command` builds argument arrays only from owned reviews and Rust-provided absolute paths. It rejects no-op/unavailable plans, changed inspection, shared input/output paths, invalid pass requests and unbounded legacy safety caps. It preserves explicit software decoders, demuxer/file-protocol restrictions, disabled MOV external references, retained-range filters, gap filling before cuts, H.264 settings, rotation/cadence handling, audio precision, two-pass logs and muxer flags. No shell is used. Maximum-size processing does not truncate with `-fs`; legacy conversion keeps its separate released safety cap.

Output inspection checks the reviewed container, track inventory, duration/endpoints, codec, geometry, orientation, cadence, layout, sample rate and precision. Structured failures match the reference. `SizeControl` rejects missing/empty/oversized results and permits at most one bounded bitrate correction, without silently changing picture or audio choices. These are core decisions: the future operation owner must still enforce cleanup between attempts, lease the source and publish only validated results while retaining previous successes.

`processing_media.rs` generates and transforms media using Rust planning, commands, supervision and validation, without invoking the JavaScript backend. It compares decoded FLAC/WAV samples exactly for integer 16/24/32-bit and float 32/64-bit sources, including cuts and multiple rates. All nine supported layouts retain channel identity; Opus tests check resampling, decoded duration/priming and the side-surround rejection. Additional cases cover MKV Opus/FLAC, scaling/cadence, two-pass bitrate/size, legacy conversion, shifted video/audio starts, retained leading silence, internal gaps and a silent video tail. A faithful remux preserves decoded samples; a MOV remux that loses a PCM timestamp gap is rejected by the preserved endpoint check. No-op plans cannot start an encoder and source bytes remain unchanged. Actual no-op delivery leases and result publication are still 8C work.

### Worker ownership

`Supervisor` tracks each worker independently of the waiting command. Dropping the caller cancels the operation but does not abort supervision. Caller-owned reservation/file/slot guards move into the worker task and are released only after confirmed process-tree exit, including successful parents that leave descendants holding stdout/stderr open. Shutdown cancels and drains tracked tasks before asset cleanup; if confirmation exceeds five seconds, it reports pending exit and retains ownership for a later close attempt.

Windows starts children suspended, assigns a kill-on-close Job Object and then resumes them. Exit confirmation checks job accounting against completion-port process notifications and waits on retained process handles. An empty active-process count alone failed the descendant regression test and is no longer sufficient. Notification/handle errors keep exit unconfirmed. Unix uses a dedicated process group and confirms its disappearance after signalling it. This is lifecycle supervision, not an OS sandbox for hostile custom executables.

Long encodes stream progress into one replaceable snapshot rather than accumulating stdout. Progress lines are bounded to 8 KiB, malformed timestamps are ignored and stderr remains independently bounded. Zero is a valid FFmpeg timestamp, distinct from no progress received. The worker tests cover success, failure, excess output, timeout, cancellation, an abandoned caller, shutdown, inherited pipes and malformed/excess progress. Full application queue/reservation integration remains 8C.

To deliberately regenerate the corpora from the reference, run `node scripts/desktop-policy-fixtures.cjs --write`, `node scripts/desktop-inspection-fixtures.cjs --write` or `node scripts/desktop-processing-fixtures.cjs --write` and review the fixture diff. Normal tests never regenerate expected results. The reference scripts are development tooling; desktop policy does not invoke Node or the JavaScript backend.

## Rust walkthrough

`Option<T>` expresses evidence that may be absent: `None` means unknown, not a guessed sample precision. `Result<T, E>` separates a usable encoding decision from a structured explanation of why it is unavailable. `Representation` is an enum, so integer and floating-point samples have explicit cases. Serde serializes the typed result using the existing JavaScript field names.

`EditPlan` owns a private vector of ranges. Its constructor validates the request, and callers borrow a read-only slice when building future commands. This lets the backend preserve a reviewed decision independently of later interface edits. These rules are ordinary Rust library functions that can be tested without opening a window.

Capability discovery uses an asynchronous `Mutex` to admit one check at a time and `Arc` to share its immutable result. Waiting callers do not each launch another FFmpeg process. Cancelling a waiting caller leaves the active check alone; cancelling the active check discards its unfinished result so a later request can retry. These are Rust ownership and concurrency tools, not a separate server.

`Settings::normalize` is the constructor that turns untrusted JSON into owned, validated settings. The private `ReviewedPlan` constructor then captures the resulting decision; changing the original request or a serialized copy cannot mutate it. `Result` carries invalid requests separately from valid reviews whose status explains why a particular operation is unavailable. The JSON-shaped review preserves the interface's existing field meanings while keeping execution authority inside Rust.

Worker guards demonstrate why Rust ownership is useful here: moving a reservation into the supervising task keeps it alive even if the interface stops waiting. Its destructor runs after process exit confirmation. A Tokio watch channel keeps only the latest progress value, so a long encode cannot grow a queue of obsolete progress messages.

## Remaining work in this PR

8B is not ready to merge until all of the following are implemented and validated:

1. Close any failures in the new command, validation, generated-media and worker-ownership suites on every native platform. Record exact-revision receipts before accepting this increment.
2. Review the remaining operation boundaries before 8C: authoritative source lookup and admission, no-op leases, correction-attempt cleanup, publication and retention of previous results. Core decisions exist; the native workspace/queue must enforce them before a user can process files.
3. Complete stage acceptance against the parity register and all reference/native gates. No complete Local Media or Download workflow is claimed by these core tests, and no working-looking processing controls are added during this port.

## Validation of the implemented portion

Run `npm run check`, `npm run test:media`, `npm run test:browser`, `npm run fmt:desktop`, `npm run check:desktop`, `npm run test:desktop:core`, `npm run test:desktop:host`, and `git diff --check`. The shared JavaScript check is included in `npm run check`; the Rust corpus test is included in `npm run test:desktop:core` on every native CI target.

The existing Windows, Linux and both macOS native gates remain required on staging. This continuation changes native inspection and tool capture, so it also requires native playback/cleanup regression tests and a normal build without test controls afterward. No package, tag, update metadata or release is produced. Roadmap #7 remains incomplete.

### Feature-register validation and playback regression

The register increment at `42b4b36` passed 589 local checks, its eight validator tests, released-tree reference validation, prior-head comparison and `git diff --check`. The strict release check failed as expected because no capability has complete native verification. The [Linux/Windows reference workflow](https://github.com/landonrivers/LVOVD/actions/runs/39162731563) passed on that commit.

The [native workflow](https://github.com/landonrivers/LVOVD/actions/runs/39162731706/attempts/1) passed Windows, Linux and Intel macOS, but Apple Silicon failed while selecting a second owned copy of the generated MP4 after initial playback, seeking and layout checks had succeeded. `desktop/test/native.cjs:85` timed out waiting for the newly selected media's metadata; the webview reported error 4 with readyState 0. The original protocol log showed successful range responses but did not establish the cause. That increment changed no runtime code. The finding was kept open instead of waiving it or weakening the test.

One [targeted rerun](https://github.com/landonrivers/LVOVD/actions/runs/39162731706/attempts/2) passed on the same implementation revision, including the normal build without test controls. That established an intermittent failure, not a diagnosed fix, and prompted investigation of selection/read admission and decoder lifecycle. The original failure evidence and all platform gates remain recorded here.

The follow-up reproducer holds four old-file range reads while selecting a second copy. With the previous handler it fails at the same new-file metadata wait and records five immediate 429 responses, which previously bypassed the diagnostic log. The replacement retains four active responders but admits at most 32 requests, waits asynchronously up to five seconds, and keeps shutdown ownership through response delivery. Removed sources are rechecked after waiting. All three Windows native fixtures pass under this forced contention. The test-only read delay is compiled out of normal builds. CSP permits fetches only to the same owned media origins already allowed for playback, retaining the protocol's identity and origin checks.

At `8a7e18147fca39bd45d4f554d610bd28c4786afd`, the strengthened [native workflow](https://github.com/landonrivers/LVOVD/actions/runs/39164673329) passed Windows, Linux, Intel macOS and Apple Silicon, including normal builds without test controls. The [reference workflow](https://github.com/landonrivers/LVOVD/actions/runs/39164673342) also passed. This resolves the reproduced read-admission failure; it does not mark the complete 8C playback/proxy workflow Verified. Queue bounds, timeout/cancellation, shutdown during a blocking read and removal of a queued source have Rust regression tests.

The settings/plans increment at `119e612f65784239c05a1901af6eb9c52079789a` passed 590 JavaScript checks, 123 generated-media reference tests, 68 Chromium tests, Rust core/host tests, formatting and Clippy, its 337 shared plan cases, and all three Windows native fixtures. Its [native workflow](https://github.com/landonrivers/LVOVD/actions/runs/39166413180) passed all four targets and its [reference workflow](https://github.com/landonrivers/LVOVD/actions/runs/39166413164) passed. Those receipts precede the command/worker increment; its exact-revision receipts belong in PR #53 before acceptance. No live-provider test was run.

## Download remains required

The desktop preview is not yet a replacement Video Downloader. Stage 8D must restore URL Preview, automatic/manual format selection, ordinary single downloads, playlist selection and queueing, serialized acquisition with the released 0.5–1-second pauses, stop-on-rejection behavior, cancellation/failure recovery, history and native saving. Editing must remain optional for ordinary downloads. The inspection and capability work here supplies facts needed for safe Download conversion as well as Local Media; it does not replace source acquisition.

Passing Local Media tests cannot satisfy this gate. Keep the working v2.7 downloader on `master` throughout migration, and require deterministic Download regression tests plus the planned live-provider acceptance pass before v3.0 release.
