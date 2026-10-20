# v3.0 desktop migration — 8C (in progress)

8C starts from the accepted [8B PR #53](https://github.com/landonrivers/LVOVD/pull/53), merged into `staging/v3-desktop` at `109cf635301dc8f28ae18cbffa5cf8fde41e14d0`. The accepted head was `10c5cbfd988ba655994971dbaf60b461dc7caa96`; its [native matrix](https://github.com/landonrivers/LVOVD/actions/runs/39182782850) and [reference checks](https://github.com/landonrivers/LVOVD/actions/runs/39182795892) passed. This accepts the policy, supervision and unified ownership checkpoint. It does not claim completed native Local Media or Download workflows.

This stage uses `codex/desktop-local-media` and a separate draft PR targeting staging. `master` remains the released v2.7 application. No promotion, tag or release is authorized. See the [development contract](development-contract.md), [feature parity register](v3-feature-parity.md), [8B ownership handoff](desktop-media-policies.md) and [native executable setup](desktop-foundation.md).

## First increment: owned queue

`ProcessingQueue` connects ordered jobs to the accepted `Processing` owner. The next increment below connects that owner to collection-scoped native commands. The trim editor, processing controls and result presentation remain unfinished.

- Batch admission checks all source identities, current review keys, required acknowledgements and the shared 20-operation limit before reserving any slot. Source membership and reviews cannot change between final validation and committing the batch. A bad entry admits none of the submission.
- Queued entries own single-use `Prepared` tickets. Each captures its source, draft revision, reviewed settings, cuts and filename. Later reviews cannot rewrite those tickets. A single drain processes them in submission order, after the preceding operation's worker and cleanup have settled.
- Snapshots carry a queue identity and increasing revision. Tokio's `watch` retains one current snapshot for slow or disconnected readers, rather than a history of progress events. Reconnection starts with current state. The native adapter below preserves bounded delivery and scopes snapshots to their workbench/connection.
- Individual cancellation selects the exact job identity. Cancel All invalidates a pending batch and cancels every selected job before another can start. The application retains active work until supervision confirms exit. Cancellation that arrives after successful publication does not relabel the valid result as cancelled.
- Unstarted jobs retain the reference's one-hour expiry. The queue checks waiting jobs while a worker runs and before starting the next job. At most 20 jobs are live, and at most 40 latest-per-source rows are retained for the eventual two workbenches. Removing a member must retire its row through the collection owner.
- A failed retry carries its own failure and no new result. `Processing` still owns the previous successful result separately. Source revocation followed by row retirement prevents late completion from inserting a removed file again. The queue never deletes original or exported files.
- Shutdown closes admission, invalidates pending batches, cancels unstarted tickets, and waits for tracked jobs. The workbench owner then shuts down `Processing`, followed by `Assets`. A five-second wait reports pending shutdown without abandoning ownership.

The queue is intentionally not created as a second independent processing owner. Integration must create one application `Processing` instance and one queue using it. Creating independent owners per file would break global admission, worker serialization and cleanup authority.

Affected register entries remain honest: `media.review-contract`, `media.batch-review`, `media.processing-queue`, `media.results`, `media.remove`, `media.expiry`, `media.reservations`, and `desktop.shutdown` are still **Missing** because the complete corresponding workflows and/or collection policies are not yet ported. `media.output-validation` remains **Ported**. No new Integrated or Verified claim is made.

## Second increment: workbench authority and native commands

One application `Workbenches` owner now contains the single processing owner and queue. It admits two workbenches with twenty files each, preserves ordered multi-file intake, and uses the source store's shared 100 GiB accounting. Waiting imports reserve collection slots. Removed files continue to occupy slots and source-byte reservations while workers, output readers, or failed cleanup own them. An abandoned command cannot orphan an admitted import; it completes into its original workbench, or cancels after discard.

Every review, batch, cancellation and removal supplies both workbench and source/job identities. Rust rejects a source or job belonging to another collection, stale reviews, oversized settings and additional authority fields. Cancel All invalidates that workbench's pending admission. The command cannot provide a file path, inspection, executable or argument list. The native picker and OS drop handler alone supply selected paths; the drop destination is captured when the event arrives.

Native commands now include create/list/subscribe/acknowledge workbench, picker intake, review/queue/cancel processing, remove/discard and cleanup. Runtime health and shutdown remain explicit permissions. The host creates one processing owner, performs bounded capability discovery, and shuts down the queue, processing, and sources in ownership order. Ordinary no-op processing and an audio-to-PCM conversion are exercised through actual native commands; this does not yet provide the complete editor workflow.

Each connection carries a Rust identity, frontend connection generation, collection revision and queue revision. At most one snapshot awaits acknowledgement; subsequent updates coalesce in the owners until it is acknowledged. Reconnection returns fresh state. Old acknowledgements cannot release a newer connection's pending snapshot. A fifteen-second heartbeat keeps the selected workbench active; idle workbenches expire after one hour, while importing/running/queued work prevents expiry. Physical cleanup remains reachable after revocation. Failed cleanup requires an explicit retry rather than endless polling retries.

The visible preview can create, switch/reopen and discard workbenches, import multiple files and remove members. Authoritative snapshots control membership and cleanup; responses from the previous workbench or older revisions cannot restore rows or status. These controls establish the editor's ownership boundary without adding replacement trim or processing controls.

New core regressions cover cross-workbench authority, two-by-twenty capacity, retained source/result leases, abandoned and discarded intake, ordered partial failure, idle expiry and hostile/stale reviews. Host tests exercise request shapes and channel backpressure. Browser tests hold responses across selection and workbench changes. The native suite adds workbench reopening, wrong-collection rejection, owned no-op publication, PCM conversion and discard to the existing playback/seek/removal tests. Platform receipts belong to the tested PR head; no complete editor or 8C acceptance is claimed.

The register still has **77 Missing, 10 Ported, zero Integrated and zero Verified** entries. Partial native command integration does not establish an entire baseline capability. Remaining gaps below still block stage acceptance and release.

## Integration work remaining in this PR

1. Extend the collection owner to editor preparation, proxy/waveform tasks and the later acquisition handoffs; exercise failed-copy/cleanup behavior throughout those operations. Preserve the existing slot and byte reservations.
2. Expose result media through owned leases on both the URI transport and Linux broker, and connect result actions without letting a result or proxy impersonate the original.
3. Connect the released editor, settings, Files list, Review All Files, Queue And Process, Cancel All and revision-labelled results. Preserve shared settings with individual drafts/cuts, exact fields, keyboard/timeline controls, warnings, reviewed filenames and previous successful results. Avoid adding separate replacement controls to the foundation screen.
4. Implement playback proxies and audio waveform preparation/window/cancellation. Preserve original input authority, clocks/gaps, waveform limits, processing preemption with confirmed child exit, selection/viewport guards and usable editing after analysis failure.
5. Integrate supported legacy edited-render conversion roles, transient cleanup retries, cleanup controls and retained-workbench recovery. Neither a proxy nor an arbitrary result path may impersonate an original source.
6. Prove the complete Local Media workflow in Windows, Linux and both macOS native webviews, including generated-media parity, delayed events, immutable jobs, removal/expiry/cleanup, and desktop/narrow layouts. Keep these as release blockers until actual workflow receipts support each register entry.

Download remains required in 8D, including extras, subtitles, chapters, SponsorBlock, manual formats, playlists and both editor handoffs. Native saving/export actions and the saved-export catalog remain 8D work. The editor and queue cannot substitute for the downloader. Roadmap #7 stays incomplete.

## Rust walkthrough

A `Prepared` value is an owned admission ticket. Moving it into a queue entry transfers responsibility for the source lease and processing slot; it cannot be cloned into two jobs. If an unstarted ticket is dropped, Rust runs its cleanup automatically. For active work, the supervisor still confirms worker exit before releasing resources.

The queue uses a short `Mutex` guard to change job state atomically. It releases that guard before awaiting encoding or inspection, so a long operation does not prevent cancellation or snapshot reads. A `watch` channel publishes the latest state; subscribers can disappear without owning or destroying jobs. This separates presentation lifetime from media lifetime.

## Validation

The focused queue suite uses synthetic PCM WAV originals, actual protected FFprobe inspection and real FLAC encoding. Test-only gates hold admission, execution handoff or result delivery to exercise races deterministically; none is compiled into normal builds. Regressions cover all-or-none admission, FIFO order, changed drafts, disconnected subscribers, abandoned batch admission, active and queued cancellation, publication winning a late cancel, failure with prior success, source removal, expiry/capacity and coordinated shutdown. Existing 8B supervision, precision, timing, output-validation and failed-cleanup tests remain required.

Run `npm run check`, `npm run test:media`, `npm run test:browser`, Rust formatting/Clippy/core/host tests, parity baseline checks and `git diff --check`. Keep all four native CI targets required. The PR records results at its tested commit. Foundation playback tests are regression evidence only; they do not establish a working native editor or queue. Complete 8C acceptance, packaged-platform acceptance and live-provider checks are not claimed by this first increment.

The workbench increment passed local Windows core/host tests (including nine additional core regressions and two host boundary tests), Clippy, formatting, 590 reference checks and 123 generated-media reference tests. All three native fixtures passed playback, workbench reopening, scoped command rejection, no-op publication, PCM conversion and discard; the 1280×720 and 960×640 native layouts were inspected. The Wry test driver did not apply the default action of WebdriverIO’s option click, so the reopening test dispatches the selection change inside the actual native webview; it does not claim OS-picker interaction coverage. The expanded Chromium suite and exact-head cross-platform CI results are recorded in PR #54. No stage acceptance is claimed.
