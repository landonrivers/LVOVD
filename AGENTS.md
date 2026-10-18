# LVOVD agent instructions

## Read before changing the project

- Read [the development contract](docs/development-contract.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the relevant section of [ROADMAP.md](ROADMAP.md).
- Read [SECURITY.md](SECURITY.md) for trust boundaries. For desktop work, also read [the current desktop stage and evidence](docs/desktop-foundation.md).
- Treat these files as shared project guidance. Follow the user's current instructions and existing authorization; do not invent approval requirements.
- If code, documentation, and the accepted plan disagree, identify the discrepancy and correct it within the authorized scope. Do not silently change product commitments.

## Implementation

- Preserve released behavior while migrating one reviewable stage at a time. Keep policy separate from execution and interface code.
- The desktop application uses a Rust backend, Tauri native commands/channels, and the JavaScript interface. It must open as an application window and must not fall back to a localhost application server.
- The v2.7 browser application is a temporary development reference. Keep its launch path clearly separate from the desktop preview.
- The Windows application is `lvovd.exe` and starts directly. Do not require a batch file, Node, npm, or Cargo to launch a built app; those are development/build tools. Do not present `index.html`, a browser preview, or a screenshot as the runnable desktop application. Deliver the executable and state what was actually tested.
- Keep the current 8A Linux playback failure visible. Do not advance the larger backend migration or mark 8A complete before the native playback gate passes.
- Preserve original files and exported results. Keep cancellation, reservations, read leases, and failed cleanup under backend ownership.
- Do not add features outside the accepted stage merely to make a preview look complete.

## Interface and copy

- Prioritize clear actions, useful defaults, visible state, and recovery from errors.
- Use short, literal labels and contextual help. Every sentence in the application must help the user choose an action, understand current state, or recover from a problem.
- Do not add marketing slogans, filler, repeated privacy claims, architectural explanations, roadmap commentary, or developer celebration to normal workflows.
- Put technical diagnostics in Runtime details and development explanations in documentation. A preview needs one concise limitation notice, not repeated milestone explanations.
- Preserve the established visual direction and keyboard access. Do not introduce a new branding exercise or layout rewrite without task scope for it.

## Validation and delivery

- Follow the change-specific validation matrix in CONTRIBUTING.md. Test real behavior; do not add tests that merely duplicate copy or implementation.
- Native playback requires actual platform webviews. Chromium or mocked command tests alone cannot establish desktop compatibility.
- Keep synthetic examples in public artifacts; never publish private source URLs, media titles, cookies, credentials, or local media.
- Inspect the diff and run `git diff --check`. Report passed, failed, and untested checks separately. Never turn an unresolved failure into a skipped gate.
- Update the development contract when an accepted product decision changes, and stage documentation when implementation evidence changes. Keep them consistent rather than duplicating instructions across agent files.
- PR preparation is authorized for the current migration. Merge, tagging, and publication require separate user authorization.

## User communication

Explain the outcome and practical limitations plainly. For a recommended next step, say what to do, why it matters, and exactly what the user needs to do or approve. Respect authorization already given. Finish the recommendation with method/mode, model, and thinking level, clearly identified as recommended settings rather than observed settings.
