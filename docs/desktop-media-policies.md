# v3.0 desktop migration — 8B (in progress)

Stage 8B continues from the [8A staging merge](https://github.com/landonrivers/LVOVD/pull/52) on `staging/v3-desktop`. Its PR targets staging; `master` remains the released v2.7 application. This document records partial implementation, not stage acceptance or release readiness. Follow the [development contract](development-contract.md) and [8A setup and platform evidence](desktop-foundation.md).

The [feature parity register](v3-feature-parity.md) now maps every audited v2.7 capability and accepted desktop addition to its native workflow and migration stage. Five policy/inspection entries are Ported; no completed user workflow is claimed Verified. CI validates register/test references, prevents silent inventory loss against prior revisions, and blocks stable-version acceptance while any required entry remains incomplete. This is migration tracking, not implementation of the missing Download or Local Media operations.

## Implemented first

The Rust core now contains audio policy, retained-range normalization, media inspection and FFmpeg capability discovery. Policy and normalization remain separate from tool execution. Native intake uses the new inspection facts; capability discovery is ready for the processing planner and is not added to the short runtime-health probe. The desktop preview still exposes the 8A workflow; processing and Download operations are not yet connected.

- Audio precision remains unknown when the source evidence is insufficient. FLAC requires proven integer precision through 24 bits, preserves sample rate/layout, and retains actionable WAV guidance. WAV chooses a preserving integer or floating-point representation. Opus uses the existing channel/layout and bitrate restrictions. AAC/MP3 retain the released decisions.
- Audio-only timelines use the selected stream's start and endpoint; video retains the common media clock. This is timing-policy parity, not a new playback adapter or a decoded-media timing proof.
- Version 1 retained ranges validate raw bounds, ordering and overlap before millisecond rounding. Adjacent rounded ranges merge. The 50-range limit, no-op rejection, error messages and retained duration match the reference.
- Normalized edit plans own their ranges and expose read-only access. Mutating a request afterward cannot change the normalized plan. Full queued-job immutability remains part of later operation integration.

`test/fixtures/desktop-policy-v1.json` holds 170 synthetic cases with expected outputs from v2.7.0 (`7e192ad`). The JavaScript reference and Rust tests independently read the same corpus. It covers integer/float/unknown precision, conflicting evidence, supported and unsupported layouts, missing metadata, bitrate edges, resampling decisions, audio clocks and retained-range validation. Rust also rejects non-finite internal arguments that cannot arrive as JSON numbers.

`test/fixtures/desktop-inspection-v1.json` adds 75 shared cases for container brand evidence, stream selection, cover art, timing origins/endpoints, Matroska duration tags, orientation/display matrices, HDR/alpha evidence, precision, frame rates, capability aliases and hardware-only decoders. Generated 16/24/32-bit integer and 32/64-bit floating-point WAV files at several sample rates, plus shifted MP4/MKV sources, are inspected by both implementations and compared. Live local FFmpeg listings are also compared with the reference parser; these tests do not contact media providers.

Inspection captures at most 4 MiB and 64 streams, limits chapters to 10,000, and keeps the reference's bounded text, format-name and side-data handling. Malformed stream objects and oversized payloads fail closed. Selected metadata omits filenames, arbitrary tags and raw diagnostics. The legacy playback descriptor stays available with additive `media` facts; attached artwork no longer selects a video MIME type for an audio source. FFprobe retains the local-only demuxer/protocol policy and now rejects an external-track warning even after a successful exit. Real MOV reference and playlist tests check this boundary and preserve original files.

Capability discovery runs only version/encoder/decoder/muxer listings against an explicit executable path, with a five-second deadline per command and a shared 4 MiB stdout/stderr ceiling. Parsing limits listings to 10,000 lines of at most 4,096 UTF-16 units each. Concurrent requests reuse one discovery; success is cached for that tool instance, failure retries after 30 seconds, and cancellation is not cached. Software decoder selection uses explicit listing aliases and excludes hardware implementations. No missing encoder or muxer is invented. Tests exercise missing/failing tools, malformed/oversized output, deadlines, cancellation, concurrent reuse, failure cooldown and redacted errors.

To deliberately regenerate the corpora from the reference, run `node scripts/desktop-policy-fixtures.cjs --write` or `node scripts/desktop-inspection-fixtures.cjs --write` and review the fixture diff. Normal tests never regenerate expected results. The reference scripts are development tooling; desktop policy does not invoke Node or the JavaScript backend.

## Rust walkthrough

`Option<T>` expresses evidence that may be absent: `None` means unknown, not a guessed sample precision. `Result<T, E>` separates a usable encoding decision from a structured explanation of why it is unavailable. `Representation` is an enum, so integer and floating-point samples have explicit cases. Serde serializes the typed result using the existing JavaScript field names.

`EditPlan` owns a private vector of ranges. Its constructor validates the request, and callers borrow a read-only slice when building future commands. This lets the backend preserve a reviewed decision independently of later interface edits. These rules are ordinary Rust library functions that can be tested without opening a window.

Capability discovery uses an asynchronous `Mutex` to admit one check at a time and `Arc` to share its immutable result. Waiting callers do not each launch another FFmpeg process. Cancelling a waiting caller leaves the active check alone; cancelling the active check discards its unfinished result so a later request can retry. These are Rust ownership and concurrency tools, not a separate server.

## Remaining work in this PR

8B is not ready to merge until all of the following are implemented and validated:

1. Integrate the completed inspection/capability facts into the processing planner. Discovery does not itself authorize encoding, and generated inspection tests do not establish encoded-output parity.
2. Processing settings, reviewed plans and plan keys, compatibility/no-op decisions, size budgets, FFmpeg arguments and output validation. Extend the shared corpus to cover these decisions and failures. The current audio policy is not capability discovery and cannot alone authorize an executable plan.
3. Complete worker supervision: descendant termination confirmation on Windows and Unix, cancellation/deadline/output-limit paths, and ownership retained until workers exit. Preserve local-input restrictions and controlled tool configuration.
4. Generated-media comparisons for precision, channel identity, retained ranges, shifted starts, gaps, no-op bytes, MKV and size processing. Passing policy fixtures does not establish encoded-output parity.
5. All reference and native platform gates on the completed stage. Local Media integration remains 8C; no working-looking processing controls are added during this partial port.

## Validation of the implemented portion

Run `npm run check`, `npm run test:media`, `npm run test:browser`, `npm run fmt:desktop`, `npm run check:desktop`, `npm run test:desktop:core`, `npm run test:desktop:host`, and `git diff --check`. The shared JavaScript check is included in `npm run check`; the Rust corpus test is included in `npm run test:desktop:core` on every native CI target.

The existing Windows, Linux and both macOS native gates remain required on staging. This continuation changes native inspection and tool capture, so it also requires native playback/cleanup regression tests and a normal build without test controls afterward. No package, tag, update metadata or release is produced. Roadmap #7 remains incomplete.

## Download remains required

The desktop preview is not yet a replacement Video Downloader. Stage 8D must restore URL Preview, automatic/manual format selection, ordinary single downloads, playlist selection and queueing, serialized acquisition with the released 0.5–1-second pauses, stop-on-rejection behavior, cancellation/failure recovery, history and native saving. Editing must remain optional for ordinary downloads. The inspection and capability work here supplies facts needed for safe Download conversion as well as Local Media; it does not replace source acquisition.

Passing Local Media tests cannot satisfy this gate. Keep the working v2.7 downloader on `master` throughout migration, and require deterministic Download regression tests plus the planned live-provider acceptance pass before v3.0 release.
