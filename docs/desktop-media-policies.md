# v3.0 desktop migration — 8B (in progress)

Stage 8B continues from the [8A staging merge](https://github.com/landonrivers/LVOVD/pull/52) on `staging/v3-desktop`. Its PR targets staging; `master` remains the released v2.7 application. This document records partial implementation, not stage acceptance or release readiness. Follow the [development contract](development-contract.md) and [8A setup and platform evidence](desktop-foundation.md).

## Implemented first

The Rust core now contains pure audio policy and retained-range normalization modules. They do not start processes, read files, or depend on Tauri. The desktop preview still exposes only the 8A workflow; these policies are not yet connected to processing commands.

- Audio precision remains unknown when the source evidence is insufficient. FLAC requires proven integer precision through 24 bits, preserves sample rate/layout, and retains actionable WAV guidance. WAV chooses a preserving integer or floating-point representation. Opus uses the existing channel/layout and bitrate restrictions. AAC/MP3 retain the released decisions.
- Audio-only timelines use the selected stream's start and endpoint; video retains the common media clock. This is timing-policy parity, not a new playback adapter or a decoded-media timing proof.
- Version 1 retained ranges validate raw bounds, ordering and overlap before millisecond rounding. Adjacent rounded ranges merge. The 50-range limit, no-op rejection, error messages and retained duration match the reference.
- Normalized edit plans own their ranges and expose read-only access. Mutating a request afterward cannot change the normalized plan. Full queued-job immutability remains part of later operation integration.

`test/fixtures/desktop-policy-v1.json` holds 170 synthetic cases with expected outputs from v2.7.0 (`7e192ad`). The JavaScript reference and Rust tests independently read the same corpus. It covers integer/float/unknown precision, conflicting evidence, supported and unsupported layouts, missing metadata, bitrate edges, resampling decisions, audio clocks and retained-range validation. Rust also rejects non-finite internal arguments that cannot arrive as JSON numbers.

To deliberately regenerate the corpus from the reference, run `node scripts/desktop-policy-fixtures.cjs --write` and review the fixture diff. Normal tests never regenerate expected results. The reference script is development tooling; desktop policy does not invoke Node or the JavaScript backend.

## Rust walkthrough

`Option<T>` expresses evidence that may be absent: `None` means unknown, not a guessed sample precision. `Result<T, E>` separates a usable encoding decision from a structured explanation of why it is unavailable. `Representation` is an enum, so integer and floating-point samples have explicit cases. Serde serializes the typed result using the existing JavaScript field names.

`EditPlan` owns a private vector of ranges. Its constructor validates the request, and callers borrow a read-only slice when building future commands. This lets the backend preserve a reviewed decision independently of later interface edits. These rules are ordinary Rust library functions that can be tested without opening a window.

## Remaining work in this PR

8B is not ready to merge until all of the following are implemented and validated:

1. Full inspection parity, including container evidence, stream selection, orientation, precision and timestamp metadata; bounded capability discovery and software decoder selection.
2. Processing settings, reviewed plans and plan keys, compatibility/no-op decisions, size budgets, FFmpeg arguments and output validation. Extend the shared corpus to cover these decisions and failures. The current audio policy is not capability discovery and cannot alone authorize an executable plan.
3. Complete worker supervision: descendant termination confirmation on Windows and Unix, cancellation/deadline/output-limit paths, and ownership retained until workers exit. Preserve local-input restrictions and controlled tool configuration.
4. Generated-media comparisons for precision, channel identity, retained ranges, shifted starts, gaps, no-op bytes, MKV and size processing. Passing policy fixtures does not establish encoded-output parity.
5. All reference and native platform gates on the completed stage. Local Media integration remains 8C; no working-looking processing controls are added during this partial port.

## Validation of the initial policy slice

Run `npm run check`, `npm run test:media`, `npm run test:browser`, `npm run fmt:desktop`, `npm run check:desktop`, `npm run test:desktop:core`, `npm run test:desktop:host`, and `git diff --check`. The shared JavaScript check is included in `npm run check`; the Rust corpus test is included in `npm run test:desktop:core` on every native CI target.

The existing Windows, Linux and both macOS native gates remain required on staging. There are no interface, permission, playback-transport or launch changes in this slice. No package, tag, update metadata or release is produced. Roadmap #7 remains incomplete.
