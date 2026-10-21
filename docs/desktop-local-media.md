# v3.0 desktop migration — 8C Local Media

8C builds on [accepted 8B PR #53](https://github.com/landonrivers/LVOVD/pull/53), staging commit `109cf635301dc8f28ae18cbffa5cf8fde41e14d0`. The accepted 8B head was `10c5cbfd988ba655994971dbaf60b461dc7caa96`; its [native matrix](https://github.com/landonrivers/LVOVD/actions/runs/39182782850) and [reference checks](https://github.com/landonrivers/LVOVD/actions/runs/39182795892) passed.

[PR #54](https://github.com/landonrivers/LVOVD/pull/54) targets `staging/v3-desktop`. No merge, promotion, tag or release is authorized. `master` remains the working v2.7 release. Follow the [development contract](development-contract.md), [parity register](v3-feature-parity.md), [8B ownership checkpoint](desktop-media-policies.md) and [native executable setup](desktop-foundation.md).

## One workbench, multiple files

The user approved one active workbench with up to twenty files. Opening or reconnecting returns that workbench; there is no New Workbench button or switcher. A discarded workbench can remain internally while cleanup is pending, but it is not another editable workbench. Those records retain their capacity and byte reservations until workers, readers and cleanup finish. Retired cleanup appears in a cleanup-only panel with Retry; it cannot reopen a workbench or replace the active selection. The accepted change is recorded against `media.reopen` and `media.reservations` in the parity register.

The desktop reuses the released Local Media controls: native picker/drop, Files list, inspection, per-file retained ranges and middle removals, exact fields, keyboard/timeline/zoom controls, waveform overview, shared processing settings, Review All Files, Queue And Process, Cancel All, revision-labelled results and Edit source. Selection preserves each file's draft. Reset File retains its source; Remove File and Discard revoke access and retire owned work. Same-session reconnection restores authoritative files, jobs and results; editing projects and queues are not persisted across application restarts.

`workspace-transport.js` maps the existing interface operations to explicit Tauri commands and scoped channels. Its endpoint-shaped names are internal dispatch, not an HTTP connection. The desktop has no localhost application server or Node application backend. The normal Windows build opens directly as `target/debug/lvovd.exe`.

## Ownership and execution

One application `Workbenches` owner contains one `Processing` owner, one queue and one analysis owner. Native picker and drop handlers register selected paths; general commands accept identities, settings and reviewed keys, never executable paths, argument lists or user-provided inspection authority. Every operation validates collection membership and source/job/result roles.

Batch admission validates every entry before reserving any slot. Each single-use `Prepared` ticket captures the original or supported edited input, cuts, settings, draft revision and filename. Later edits cannot mutate queued jobs. The queue executes sequentially, preserves the prior successful result after a failed attempt, and never substitutes it for a failed latest attempt in Save All. Cancellation confirms child-process-tree exit before releasing processing/storage ownership. Unstarted jobs expire after one hour; live admission remains bounded at twenty jobs.

Snapshots carry collection, queue and connection revisions. At most one snapshot awaits acknowledgement; later changes coalesce. Reconnection receives current state. The interface retains collection, source, operation, connection and viewport guards against late responses. A heartbeat keeps the active workbench alive; idle workbenches expire after an hour, while intake and queued/running work prevent expiry.

Revoked source/result identities cannot acquire new readers. Existing readers retain their underlying leases until closed. Cleanup uses bounded automatic retries, followed by a reachable manual retry; unsuccessful deletion continues to reserve capacity. Cleanup never targets originals or exported files. Shutdown closes admission, cancels analysis and queued/active work, waits for supervised descendants and outstanding dialogs, then retires owned files.

## Playback, waveforms and processing

Compatible MP4/H.264/AAC and M4A/AAC can play directly where their timestamps permit. Other supported inputs prepare a separate owned MP4 playback proxy. Final processing reads the authoritative original, or the explicit legacy edited-input role; proxy identities cannot be used for processing. Originals, proxies and validated results use the same bounded media-reader contract through the platform URI transport and Linux private broker.

One analysis worker prepares combined-channel min/max waveform overviews by streaming decoded PCM. It enforces a 120-second budget, an inspected-duration byte ceiling, at most 200,000 cached peak pairs, bins no finer than 10 ms and at most 4,096 returned pairs. Foreground processing cancels analysis and waits for worker exit before admission. Failed/cancelled analysis can be retried and does not remove valid trim/processing controls. Committed cuts keep millisecond precision.

The existing processing controls use the accepted 8B policies for unchanged-file byte preservation, copy/remux, H.264 quality/bitrate/maximum-size modes, dimensions/frame rate, supported audio formats, strict local FLAC precision, layout/rate restrictions and actual output validation. Queue progress identifies passes and validation; it uses the captured job duration, not a later edited draft. Result details show inspected output facts.

Native `review_render` and `review_conversion` retain the released legacy conversion contract alongside the unified editor. The conversion input must be an owned original or the current edited output with matching retained ranges. Stale cuts, proxies and arbitrary conversion results are rejected. Edited-input leases survive repeated byte-preserving conversions and abandoned callers. Duration validation remains strict, including tool-version-dependent short AAC-to-MP3 padding failures; failure retains the prior valid result.

## Saving

Save and Save All capture validated output leases before opening a native destination dialog. Writes use a temporary destination file, flush/sync and close it, then publish without overwriting an existing file; collisions receive numbered names. Missing/unwritable destinations return an actionable failure and leave the prepared result available for retry. A bulk save reports each captured result independently. Removal or replacement stops pending saves; the copy rechecks current ownership while reading and before publication. Late receipts cannot label a replacement result as saved. Removing sources does not delete successful exports.

Automatic saving to a remembered destination, export receipts/catalog, Open/Show in Folder and saved-file persistence belong to 8D. The present explicit Save/Save All workflow preserves access to Local Media results while that shared delivery layer is built.

## Acceptance evidence

8C implementation is complete for review at `14bb94320233b30fb7eafe663fce100d89d4293f`. All required native jobs and the reference workflow passed. PR #54 remains unmerged; these receipts do not authorize promotion or release.

| Platform | Passed native receipt |
|---|---|
| Windows x64 / WebView2 | [Job 119012054518](https://github.com/landonrivers/LVOVD/actions/runs/39535701160/job/119012054518) |
| Linux x64 / Ubuntu 22.04 / WebKitGTK | [Job 119012054508](https://github.com/landonrivers/LVOVD/actions/runs/39535701160/job/119012054508) |
| macOS ARM64 / WKWebView | [Job 119012054585](https://github.com/landonrivers/LVOVD/actions/runs/39535701160/job/119012054585) |
| macOS x64 / WKWebView | [Job 119012054629](https://github.com/landonrivers/LVOVD/actions/runs/39535701160/job/119012054629) |

Each job runs formatting, Clippy, Rust core/generated-media/host tests, builds the test application, drives actual native workflows and rebuilds without test controls. Actual MP4, M4A, tail-index MP4 and 24-bit WAV workflows pass playback, repeated/end seeking, removal, single-workbench reuse, no-op saving and 1280×720/960×640 layout bounds. MP4/WAV exercise independent cuts, middle removal/restoration, keyboard trims, zoom, Reset File, immutable batch snapshots/names, encoded result playback and Save All. Controls also produce Opus/FLAC/WAV and two-pass size-limited video. Tail-index MP4 exercises legacy render-to-M4A conversion through native commands.

Desktop/narrow screenshots from all four jobs were inspected, including audio playback and processing results. The native driver chooses synthetic files and destinations through test-only hooks; this does not claim manual OS dialog interaction, packaged clean-machine acceptance or arbitrary display scaling. Normal builds exclude the driver and hooks. The local normal Windows executable was rebuilt and launched directly: its native window title is LVOVD, its process has no listening TCP socket, and coordinated close exits successfully. No HTML/browser launch was used for native acceptance.

The [reference workflow](https://github.com/landonrivers/LVOVD/actions/runs/39535701153) passed **590 fast checks, 123 generated-media tests and 72 Chromium tests**, including the retained Windows launcher/tool-manager gate. Chromium covers delayed native adapter replies, failed intake, save receipts/replacement, cleanup-only recovery and missing-bridge behavior. Core tests cover real-media policies, all-or-none batches, cancellation/expiry, source/result leases, original/export preservation, streaming worker failures, waveform bounds/deadlines/preemption, stale operation windows, failed cleanup/retry, legacy input roles and save collisions/unavailable destinations. Host tests reject additional authority fields and verify scoped channel backpressure. `git diff --check` passes.

The parity register records **34 Verified Local Media entries**, **one Integrated shared reservation entry**, and **52 Missing entries**. The verified entries combine the real native workflow receipts with their mapped policy, generated-media, lifecycle and interface regressions; no library-only result establishes a native workflow. `media.reservations` intentionally remains Integrated: its local-file/job limits and storage owner are verified, but 8D must connect playlist selection and acquisition intermediates to that same owner. That unfinished acquisition portion remains a release blocker. Automatic destination saving/catalog/open/reveal remains a separate 8D delivery commitment; the completed Save/Save All workflow does not waive it.

Earlier integration checks caught a strict browser waveform-query regression and corrupted UTF-8 parity text; both were corrected without weakening the reference checker. Review also closed delayed-save/replacement publication, empty cleanup acknowledgements and a transient validation label that remained after completion. Their regression tests and replacement platform runs pass. The checked-in receipts refer to the implementation revision above; later documentation-only commits record those receipts without changing the tested application.

## Rust walkthrough

A `Prepared` value is an owned admission ticket. Moving it into a queue entry transfers responsibility for its source/result lease and processing slot; it cannot be cloned into two jobs. Dropping an unstarted ticket releases its reservation. An active worker has a separate owner that survives an abandoned caller until the supervisor confirms process exit.

`Arc` shares ownership of an original, edited input or result among the operation and its readers. Removal revokes access immediately, but physical deletion waits until the final reader releases its reference. Short `Mutex` guards update state atomically and are released before awaiting media tools. `watch` channels publish the latest state without making the interface responsible for keeping jobs alive. `Result` carries validation or execution failures back to the controls without confusing them with successful publication.

## Next stage and release boundaries

8D must restore the program's primary workflow: yt-dlp URL Preview and downloads, all content modes and source formats, audio conversion, ranges/chapters, extras/subtitles, SponsorBlock, playlists, pacing/cancellation, both editor handoffs, History, managed/custom tools/plugins and complete native saving. None is optional or replaced by the editor.

8E still completes navigation, settings/persistence, accessibility, quit handling and production cutover. 8F supplies tools, installers/portable packages, updates, security maintenance and packaged-platform acceptance. Roadmap #7 remains incomplete. Stable v3.0 requires every baseline media capability to be verified; this PR is not a release.
