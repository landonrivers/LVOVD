# Contributing to LVOVD

LVOVD — **Landon's Very Own Video Downloader** — is intentionally open for experimentation, bug fixes, cleanup, source-service expansion, and new yt-dlp features.

## Development setup

Read [the development contract](docs/development-contract.md) before making changes. Coding agents must also follow [AGENTS.md](AGENTS.md). The contract preserves the product decisions; the roadmap and stage documents track what is implemented.

### Rust desktop preview

Follow [desktop setup and current limitations](docs/desktop-foundation.md). Run `npm ci` and `npm run dev:desktop`, or use `Start-LVOVD-Desktop-Windows.bat` on Windows after setup. This opens an application window. Do not open `desktop/index.html` or `desktop/dist/index.html` as the application: those are internal interface assets and cannot provide native operations in Chrome.

The development launcher compiles a normal debug build without the test driver. The Windows launcher closes its terminal after opening the app. This is a development convenience, not the finished installer or portable distribution.

### v2.7 browser reference

1. Install Node.js 22 or newer.
2. Install FFmpeg and FFprobe and make sure both are available on PATH.
3. Run `npm start` or `node server.js`.
4. On first use, LVOVD downloads and SHA-256 verifies its project-local official yt-dlp binary; later starts reuse that verified cached copy.
5. Open `http://127.0.0.1:3000`.

LVOVD has no third-party Node runtime dependencies. Normal startup does not require installing browser-test tooling.

## Validation

Before submitting a change, run:

```bash
npm run check
```

For media/workspace changes, install FFmpeg **and FFprobe** on PATH and run `npm run test:media`. This generated-media suite requires its tools; it does not silently skip missing prerequisites. Linux CI also installs `strace` and checks local file-open boundaries.

The small browser suite uses development-only Playwright, actual app endpoints, generated local fixtures, and the normal `server.js` security gate:

```bash
npm ci
npx playwright install --with-deps --only-shell chromium
npm run test:browser
git diff --check
```

Only Chromium is required, with one worker. The suite starts a separate server on `127.0.0.1:3017`; leave that port free. It requires FFmpeg/FFprobe and makes no media-provider requests. Tool installation downloads are separate. Headless assertions do not replace Windows/browser visual and playback acceptance.

Choose additional checks by changed behavior:

| Change | Required checks |
|---|---|
| Media policy, processing, ownership, or cancellation | `npm run test:media`; affected Rust tests; compare against released behavior |
| Interface or native adapter | Affected browser tests; inspect the changed workflow at desktop/narrow sizes; native tests when desktop behavior changes |
| Rust core or host | `npm run fmt:desktop`, `npm run check:desktop`, `npm run test:desktop:core` |
| Desktop launch, permissions, protocol, or playback | Build with `node scripts/desktop.cjs build --features test-driver`, run `npm run test:desktop:native`, then rebuild without the driver; verify the normal native launch |
| Documentation or interface copy only | Check links/claims and inspect the affected presentation; do not add tests that merely freeze prose |

Run `git diff --check`. Existing Linux/Windows gates remain required; native CI covers Windows, Linux, and both Mac architectures. Report the unresolved Linux playback failure rather than skipping it or calling Chromium a substitute. Full release acceptance remains broader than any individual change's checks.

Keep processing local. The browser reference must preserve its `127.0.0.1` boundary; the desktop production path must have no localhost application server. Do not apply the browser startup model to desktop work.

When adding yt-dlp features or support for additional source services, prefer exposing understandable concepts in the UI rather than raw yt-dlp format IDs or command-line flags.

## Licensing contributions

LVOVD v2.2.6 and later are distributed under the **Apache License 2.0**. Unless you explicitly state otherwise, a contribution intentionally submitted for inclusion in LVOVD is provided under the Apache License 2.0 terms described in [LICENSE](LICENSE). Preserve the project attribution in [NOTICE](NOTICE) when redistributing derivative works as required by that license.

## Public source-example hygiene

Do not include real media titles, media URLs, channel/account names, post/video IDs, or other identifiable source-content details in public issues, pull requests, commit messages, test fixtures, documentation, release notes, screenshots, or logs.

Use generic descriptions and synthetic examples instead. Service names and non-content-specific URL shapes are fine when needed to describe compatibility, but public artifacts should not create a breadcrumb trail to specific source media or accounts.

If a real source is needed to reproduce a problem, keep those identifying details out of the public GitHub record and describe the public report generically.

Please also preserve the project's responsibility-first stance: LVOVD should help users work with media they are authorized to download, not present itself as a way to bypass access controls or rights restrictions.
