# Contributing to LVOVD

LVOVD — **Landon's Very Own Video Downloader** — is intentionally open for experimentation, bug fixes, cleanup, source-service expansion, and new yt-dlp features.

## Development setup

1. Install Node.js 22 or newer.
2. Install FFmpeg and make sure `ffmpeg` is available on PATH.
3. Run `npm i`.
4. Run `npm start` or `node server.js`.
5. Open `http://127.0.0.1:3000`.

Before submitting a change, run:

```bash
npm run check
```

Please keep the project local-first: media processing should happen on the user's machine, and the server should continue binding to `127.0.0.1` by default.

When adding yt-dlp features or support for additional source services, prefer exposing understandable concepts in the UI rather than raw yt-dlp format IDs or command-line flags.

## Public source-example hygiene

Do not include real media titles, media URLs, channel/account names, post/video IDs, or other identifiable source-content details in public issues, pull requests, commit messages, test fixtures, documentation, release notes, screenshots, or logs.

Use generic descriptions and synthetic examples instead. Service names and non-content-specific URL shapes are fine when needed to describe compatibility, but public artifacts should not create a breadcrumb trail to specific source media or accounts.

If a real source is needed to reproduce a problem, keep those identifying details out of the public GitHub record and describe the public report generically.

Please also preserve the project's responsibility-first stance: LVOVD should help users work with media they are authorized to download, not present itself as a way to bypass access controls or rights restrictions.
