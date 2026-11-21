# 8D.1 — First standalone video download

This staging milestone starts at the [8C merge](https://github.com/landonrivers/LVOVD/pull/54). Its acceptance path is to extract the Windows x64 review ZIP, launch `lvovd.exe`, preview one URL, download Video + Audio and open the saved video. The [roadmap](../ROADMAP.md#8-native-acquisition-editing-and-distribution) lists the remaining Download and distribution stages.

## Using the preview

1. Extract the complete portable package and open `lvovd.exe`. Keep the tools and prerequisites beside it. On Windows the native window uses Evergreen WebView2. [Package contents and verification](windows-portable-review.md)
2. In **Download**, paste the media URL and select **Preview**. Check the source, suggested filename, profile and folder. On first launch LVOVD uses the system Downloads folder if it exists. **Choose folder** selects a destination when the default is unavailable or you want to change it.
3. Select **Download Video**. The queue shows acquisition, processing and saving. A completed save offers **Open File** and **Show in Folder**. If saving fails, choose an available folder and use **Retry Save** while the prepared file is retained. Existing filenames get a numbered suffix.

This preview covers the default single-URL Video + Audio path. Remaining source choices, companions and chapters, playlists, editor handoffs, History and custom provider management have their own acceptance milestones. The [v2.7 release](https://github.com/landonrivers/LVOVD/releases/tag/v2.7.0) remains available for those workflows.

## How the implementation fits together

JavaScript submits a URL once for Preview. Rust validates the URL, supervises yt-dlp, normalizes its metadata and returns an opaque preview ID. The Download command takes that ID and the native destination ID. Rust captures the source choice, output name and folder when the job enters the queue. A later folder change cannot redirect it. The privileged window renders provider text literally. Optional network artwork is bounded, checked and re-encoded as a small JPEG in Rust.

The worker shares the remote acquisition slot with Preview. Subscribers receive the latest revision through a Tauri channel. Closing a view does not own or stop a job. Rust validates the prepared output and keeps it available during saving. Publishing a completed temporary file avoids overwriting a user's existing file. Open and reveal accept a saved job identity. The backend checks the saved file before handing it to the OS.

Some direct video URLs expose a visual format or media container but omit codec metadata. The desktop can attempt the reviewed single-video download in that case. FFprobe must confirm the resulting file has both audio and video before LVOVD publishes it. A restriction, missing stream or unavailable source produces an error.

This review build returns a complete queue snapshot and admits up to 256 rows. Saved, failed and cancelled rows expire after one hour. A failed save retains its file for retry or confirmed shutdown. Admission reports a full queue without evicting existing work. 8D.3 must deliver paged snapshots before claiming released queue parity.

## Acceptance evidence

The controlled test uses generated video and audio served by a fixture and the real provider tools. The fixture server supplies source media only. The released desktop program handles application operations through native commands. Tests cover initial Download navigation, reviewed source and destination, cancellation, interrupted saving, retry and name collisions. The Local Media regression scenarios exercise a delayed removal response after a change of workbench and retrying interrupted playback on the same selection.

Record the exact Windows package checksum, OS, bundled tools, controlled test outcome and separate live-provider outcome on its review PR. Keep source URLs, media titles, filenames and user profile paths out of public receipts. Development webviews, mocked commands and locally built artifacts each have a different evidentiary scope. Clean-machine acceptance requires the extracted CI artifact. Four-platform verification and remaining capabilities are tracked in the [parity register](v3-feature-parity.md).
