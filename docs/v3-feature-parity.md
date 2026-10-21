# v3.0 feature preservation register

Every released v2.7 media capability must fit into the native application. Missing functionality blocks stable v3.0; rewrite difficulty does not authorize deferral. The reference is v2.7.0 at `7e192ad7ddee6478b517a74174cedf6dccd85a19`, audited against code, controls, tests and documentation. Subsequent accepted fixes extend that reference through explicit addenda.

The [machine-readable register](v3-feature-parity.json) is the source of truth for stable capability IDs, frozen reference behavior/source files, native location, responsible stage, planned Rust operations, implementation/test links, acceptance scenarios, unfinished work and platform receipts. The table below is generated from it. Planned operation names are design mappings, not assertions that commands already exist or permission to expose them.

The only approved access-mode exception is **standalone access**: the application window replaces browser/LAN hosting, localhost startup and HOST/PORT configuration. Native file selection and saving replace browser upload/download delivery while preserving the media capabilities. Custom yt-dlp, extractor plugins and explicit data-root selection remain required. See the [development contract](development-contract.md) and [security boundary](../SECURITY.md#desktop-preview-and-maintenance).

## Status and evidence rules

- **Missing:** the capability is absent or only partly ported. Existing foundation experiments can be mentioned in `remaining`; they do not complete the capability.
- **Ported:** its core behavior exists in Rust with linked Rust tests; native workflow integration remains outstanding.
- **Integrated:** the capability is reachable through the intended native interface, with linked Rust and integration sources. Platform acceptance is not yet complete.
- **Verified:** no unfinished work, linked native workflow tests, and passed receipts for Windows x64, Linux x64, macOS ARM64 and macOS x64 at one implementation revision. Library tests, Chromium tests and an unrelated foundation playback run cannot satisfy this status.

Each receipt records platform, full commit, `native-workflow` kind, passed result, repository Actions run/job URL, mapped test files and a description of the actual scenario. A reviewer must inspect those receipts and determine whether tests cover the behavior. The validator checks completeness and references; it cannot prove that a linked test exercises the claim or that a remote run passed. Reopen a capability's status when relevant behavior changes; historical evidence is not permission to skip current CI or packaged acceptance.

Ported entries describe core policies with linked Rust tests. Integrated entries identify workflows connected to the native interface; their remaining platform acceptance is explicit. Download remains missing until 8D. [8A's native playback evidence](desktop-foundation.md) and [8B's accepted checkpoint](desktop-media-policies.md) remain useful supporting evidence, not substitutes for complete workflows.

## Maintaining the register

1. Before changing a workflow, locate every affected ID and its acceptance scenarios. Add newly discovered capabilities; do not delete, rename, reclassify or waive existing IDs to make migration appear complete. Keep reference behavior frozen; append accepted-fix records with commit, affected IDs, reason and user/accepted-PR approval.
2. Update implementation, tests, remaining work and status in the same PR as the change. A source/test link must exist; baseline links must originate in the released tree. Desktop additions explicitly use `origin: desktop` rather than pretending to be released features.
3. Run `npm run parity:docs` to regenerate this table, review the JSON and Markdown diffs, then run `npm run check:parity`. `npm run check` also validates the register. CI compares against the PR base and previous head when available to detect removed entries and rewritten reference facts.
4. Stable npm **or** Cargo metadata at v3 or later automatically enables the strict gate. `npm run check:parity:release` enables it explicitly and must fail during this incomplete migration. Future release automation must run it before publishing any artifact/update metadata. This gate does not create a release workflow or authorize publication.

Normal migration CI allows honest Missing/Ported/Integrated entries. The strict gate requires every baseline capability and accepted desktop addition to be Verified. No waiver status or optional-baseline flag exists. All normal Rust/reference/native CI, supported packaged-OS baselines, live-provider acceptance and security/artifact checks remain additional release requirements.

## Native workflow placement

Download is the initial application view. Preserve the existing JavaScript controls and defaults in Download, Local Media, History and Settings. Compact layout changes cannot remove options. Download audio conversion and strict Local Media FLAC remain distinct contracts. Extras, subtitles/languages, chapter outputs, SponsorBlock, advanced source formats, native save recovery and custom tools/plugins are explicit 8D work, not optional post-release enhancements.

8B established its policy/worker/ownership checkpoint in accepted PR #53. [8C](desktop-local-media.md) integrates the full Local Media workbench in a separate draft PR; the released editor now runs through Rust-owned workbench, analysis and processing commands. Platform acceptance is recorded in the stage document. 8D restores Download, both acquisition handoffs, history, native saving and tool/plugin management. 8E completes navigation, settings, accessibility, lifecycle and cutover. 8F supplies verified tools/frameworks, packages, updates and maintenance. Stage PRs target `staging/v3-desktop`; `master` stays on the working release. Merge, promotion, tagging and publication require separate authorization. Roadmap #7 remains incomplete.

<!-- parity-table:start -->

87 required entries: 52 Missing, 0 Ported, 35 Integrated, 0 Verified. These counts describe migration work, not a completion percentage.

| Stable ID | Capability | Native location | Stage | Status |
|---|---|---|---|---|
| `download.preview` | URL Preview | Download | 8D | Missing |
| `download.capabilities` | Source capabilities | Download | 8D | Missing |
| `download.artwork` | Preview artwork | Download / queue | 8D | Missing |
| `download.content-av` | Video + Audio | Download | 8D | Missing |
| `download.content-video` | Video Only | Download | 8D | Missing |
| `download.content-audio` | Audio Only | Download | 8D | Missing |
| `download.content-extras` | Extras Only | Download | 8D | Missing |
| `download.compatible` | Compatible MP4 | Download | 8D | Missing |
| `download.maximum` | Maximum Quality | Download | 8D | Missing |
| `download.resolution` | Resolution cap | Download | 8D | Missing |
| `download.format-inspection` | Source Formats details | Download / Source Formats | 8D | Missing |
| `download.manual-formats` | Manual source selection | Download / Source Formats | 8D | Missing |
| `download.source-audio` | Source Audio | Download | 8D | Missing |
| `download.audio-conversion` | Download audio formats | Download | 8D | Missing |
| `download.custom-range` | Custom time range | Download / Time range & chapters | 8D | Missing |
| `download.chapters` | Selected chapters | Download / Time range & chapters | 8D | Missing |
| `download.thumbnail-extra` | Thumbnail extra | Download / Extras | 8D | Missing |
| `download.metadata-extra` | Metadata JSON extra | Download / Extras | 8D | Missing |
| `download.subtitles` | Subtitles and captions | Download / Extras | 8D | Missing |
| `download.sponsorblock` | SponsorBlock | Download / SponsorBlock | 8D | Missing |
| `download.playlists` | Playlist selection | Download / Playlist | 8D | Missing |
| `download.coordination` | Source-request coordination | Download / Local Media intake | 8D | Missing |
| `download.pacing` | Playlist acquisition pauses | Download / Playlist import | 8D | Missing |
| `download.rejection` | Stop on source rejection | Download / Playlist import | 8D | Missing |
| `download.failures` | Actionable failures | Download / History / Local Media | 8D | Missing |
| `download.queue-admission` | Immutable Download queue | Download / Queue | 8D | Missing |
| `download.queue-cancel` | Download cancellation | Download / Queue | 8D | Missing |
| `download.progress` | Download progress | Download / Queue | 8D | Missing |
| `download.outputs` | Prepared Download outputs | Download / Queue | 8D | Missing |
| `download.cleanup` | Download expiry and cleanup | Download / Queue | 8D | Missing |
| `handoff.url-edit` | Edit Source Video | Download â†’ Local Media | 8D | Missing |
| `handoff.playlist-intake` | Add Selected to Local Media | Download â†’ Local Media | 8D | Missing |
| `media.intake` | Multiple local files | Local Media / Files | 8C | Integrated |
| `media.inspection` | Normalized inspection | Local Media / Media Details | 8B | Integrated |
| `media.capabilities` | Capability discovery | Local Media / Review | 8B | Integrated |
| `media.input-boundary` | Self-contained inputs | Local Media / Intake and processing | 8B | Integrated |
| `media.direct-playback` | Direct media playback | Local Media / Player | 8C | Integrated |
| `media.proxy` | Playback proxies | Local Media / Player | 8C | Integrated |
| `media.audio-clock` | Audio timeline policy | Local Media / Timeline | 8B | Integrated |
| `media.waveform` | Combined waveform | Local Media / Timeline | 8C | Integrated |
| `media.range-policy` | Retained-range normalization | Local Media / Cuts | 8B | Integrated |
| `media.trim-controls` | Trim and middle cuts | Local Media / Timeline | 8C | Integrated |
| `media.timeline-controls` | Timeline navigation and keyboard | Local Media / Timeline | 8C | Integrated |
| `media.drafts` | Per-file drafts and revisions | Local Media / Files | 8C | Integrated |
| `media.audio-policy` | Local audio encoding policy | Local Media / Output settings | 8B | Integrated |
| `media.audio-outputs` | Local audio outputs | Local Media / Output settings and results | 8C | Integrated |
| `media.noop-remux` | Original no-op and remux | Local Media / Review and results | 8B | Integrated |
| `media.video-encoding` | Video quality and bitrate | Local Media / Output settings | 8B | Integrated |
| `media.size-budget` | Maximum output size | Local Media / Output settings | 8B | Integrated |
| `media.picture` | Scaling and frame rate | Local Media / Output settings | 8B | Integrated |
| `media.estimates-help` | Linked estimates and help | Local Media / Output settings and review | 8C | Integrated |
| `media.review-contract` | Reviewed plan validation | Local Media / Review | 8B | Integrated |
| `media.edited-input` | Edited-result conversion handoff | Local Media / Conversion review | 8C | Integrated |
| `media.output-validation` | Validated processed outputs | Local Media / Results | 8B | Integrated |
| `media.naming` | Reviewed names and suffix | Local Media / Process actions | 8C | Integrated |
| `media.shared-settings` | Shared output settings | Local Media / Output settings | 8C | Integrated |
| `media.batch-review` | Review All Files | Local Media / Batch review | 8C | Integrated |
| `media.processing-queue` | Sequential processing queue | Local Media / Processing results | 8C | Integrated |
| `media.results` | Individual results and revisions | Local Media / Processing results | 8C | Integrated |
| `media.bulk-save` | Download All equivalent | Local Media / Processing results | 8D | Integrated |
| `media.reset` | Reset File | Local Media / Files | 8C | Integrated |
| `media.remove` | Remove File and Discard | Local Media / Files | 8C | Integrated |
| `media.cleanup` | Reachable cleanup recovery | Local Media / Cleanup recovery | 8C | Integrated |
| `media.expiry` | Workspace activity and expiry | Local Media | 8C | Integrated |
| `media.reopen` | Previous local workbenches | Local Media / Active workbench reconnection and cleanup recovery | 8C | Integrated |
| `media.reservations` | Capacity and storage reservations | Local Media / Intake and queue | 8C | Integrated |
| `media.leases` | Output leases and retirement | Local Media / Playback and results | 8C | Integrated |
| `history.records` | Durable terminal history | History | 8D | Missing |
| `history.presentation` | History details and pagination | History | 8D | Missing |
| `history.deletion` | Delete and Clear All | History | 8D | Missing |
| `history.reuse` | Use Again | History â†’ Download | 8D | Missing |
| `history.faults` | Nonfatal history faults | History / Download | 8D | Missing |
| `runtime.health` | Runtime status and Recheck | Settings / Runtime | 8E | Missing |
| `runtime.ytdlp-updates` | Managed yt-dlp lifecycle | Settings / Runtime | 8D | Missing |
| `runtime.custom-ytdlp` | Custom yt-dlp executable | Settings / Advanced tools | 8D | Missing |
| `runtime.extractor-plugins` | Extractor plugins | Settings / Advanced tools | 8D | Missing |
| `runtime.config-isolation` | Explicit yt-dlp configuration | Settings / Runtime | 8D | Missing |
| `runtime.data-location` | Local data location | Settings / Data and runtime details | 8E | Missing |
| `desktop.destination` | Captured output destination | Download / Local Media | 8D | Missing |
| `desktop.saving` | Atomic native saving | Download / Local Media results | 8D | Missing |
| `desktop.export-actions` | Saved-file actions and catalog | Results / History | 8D | Missing |
| `desktop.history-import` | Legacy history import | History | 8E | Missing |
| `desktop.navigation` | Complete compact interface | Download / Local Media / History / Settings | 8E | Missing |
| `desktop.settings` | Persistent settings | Settings | 8E | Missing |
| `desktop.shutdown` | Single instance and coordinated quit | Application | 8E | Missing |
| `desktop.packages` | Standalone distribution | Application launch | 8F | Missing |
| `desktop.updates` | Application update lifecycle | Settings | 8F | Missing |

<!-- parity-table:end -->
