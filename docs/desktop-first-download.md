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


## 8D.2 single-video options

The desktop Download view now builds its content, format, resolution, chapter, caption and SponsorBlock choices from the current Preview. Rust captures a typed plan and the selected destination at admission. Exact streams and chapter selections require a fresh metadata check before acquisition. Video modes remux to MP4. Source Audio keeps its acquired bytes. M4A, MP3, Opus, FLAC and WAV run the released Download conversion policy on the acquired audio.

Each chapter uses a private directory. Only requested file types can be published. Each saved file has its own receipt for Open File and Show in Folder. If saving fails partway, Retry Save continues with the first unpublished file. The chosen folder applies to the remaining outputs.

The Rust tests compare provider flags against the released JavaScript policy and probe actual conversions from compressed audio. An offline provider fixture exercises separate streams, a custom range, ordered chapters, original audio, both caption sources, JPG and JSON. A loopback SponsorBlock fixture counts requests and FFprobe checks the marked chapters and shortened output. The native fixtures exercise metadata-only acquisition, a video with a JSON companion, and a generated DASH URL. The DASH workflow selects exact streams, downloads source audio and each audio conversion, and checks the saved codecs with FFprobe. The [feature register](v3-feature-parity.md) lists outstanding evidence for each capability. Playlist selection and editor handoffs are scheduled for 8D.3. History reuse is scheduled for 8D.4.

### Packaged Download checks

On Windows 10 x64 (build 19045), the [review ZIP from PR head `b7ed452`](https://github.com/landonrivers/LVOVD/actions/runs/44875649464/artifacts/14695684777) had SHA-256 `c18a5fe382f754a9bfb0f1142d2503e3281c575ae95950e072a31ac29e49d48d`. After verifying the ZIP and its file manifest, the test launched the extracted `lvovd.exe` and selected the options in its native window. The bundled FFmpeg and FFprobe independently inspected the files saved in the selected destination.

| Selection in Download | Observation on saved output |
|---|---|
| Chapters 1 and 3 of a three-chapter fixture | Two separate H.264/AAC MP4s carried the correct chapter numbers. Their durations and decoded frame colors matched the two-second opening and four-second ending. The middle chapter produced no file. |
| English and French creator subtitles, Extras Only | Two SRT companions contained their respective language cues at the expected times. A separate request for an unavailable language ended in Failed and saved nothing. |
| Creator, Automatic, and both on a live source | Five SRT exports had a single SubRip stream and timed text. When both sources offered English, the combined choice matched the creator captions. For a language offered only as automatic, the combined choice matched the automatic captions. |
| SponsorBlock Off, Mark, and Remove on the same live source | All three MP4s fully decoded with video and audio. Off had no SponsorBlock marker. Mark preserved duration and placed the outro at the independently checked bounds. Remove shortened playback by the approximately 124-second interval within one second and left no outro marker. The offline request-count test separately checks that Off sends zero SponsorBlock requests. |

The Windows package test uses `desktop/test/packaged-download-options.ps1`. CI repeats the synthetic chapter and caption cases. Live source identifiers, captions and media stay outside the repository. The platform receipts and remaining acceptance cases are tracked per capability in the [parity register](v3-feature-parity.md).

The same Windows review ZIP also exercised **Extras Only** on a maintainer-owned Short. Thumbnail alone saved one decodable JPEG. Metadata alone saved one `.info.json` with the expected video ID and the title shown in Preview. Selecting both produced the two companions in one job. The destination contained exactly the requested new files after each save.

The [four native gates at `6398c46`](https://github.com/landonrivers/LVOVD/actions/runs/44954366282) repeated those choices with generated artwork and counted zero source-media reads. The exported JPEG retained the test PNG's dimensions and color. With no advertised artwork, the thumbnail option was disabled. A thumbnail-only job whose image request returned HTTP 403 ended in Failed and published nothing. The first Linux run stopped during fixture generation because its CI FFmpeg lacked PNG support. The corrected recipe enables zlib explicitly. Metadata selection in History reuse remains an 8D.4 acceptance case.

For live acceptance, use a video or playlist the maintainer owns and has supplied for testing. On the same verified Windows review ZIP, the `AutomaticCaptions` scenario saved two SRTs from a maintainer-owned Short that offered only automatic captions. FFprobe identified each as SubRip, and their timed cues matched between Automatic and the combined mode. The Short had no published skip segments. Use generated segments for repeatable Mark and Remove tests.

In the native test build, real yt-dlp can read a generated extractor result from the test configuration folder for one exact loopback URL. That source offers distinct creator and automatic cues, generated media and a local SponsorBlock service. The app performs selection, processing and saving through its normal native commands. Tests read the exported subtitles, count requests and probe the marked intervals and removed duration. Release builds exclude the fixture input.

At `ebafe08`, the [four native platform gates](https://github.com/landonrivers/LVOVD/actions/runs/44933999779) exercised all three caption choices and their language suggestions. The tests read each saved SRT to distinguish creator preference from automatic fallback. SponsorBlock Off sent zero segment requests. Mark preserved the selected intervals for a subset and for all nine categories. Remove requested only the outro and shortened the 20-second fixture to 10 seconds, preserving both audio and video.

### Desktop Download layout

Download opens above the active queue and Local Media. The header shortcuts move to sections of the same scrolling screen. Settings is separate. Enter a URL, preview the source, then choose content, video format and resolution. Opening a disclosure leaves its heading in its column. The content and profile cards support clickable labels and arrow-key navigation. Starting a download keeps its preview available. Queue rows show the current stage, available speed and ETA, and a berry-red progress bar with a small berry at its leading edge. An unknown amount is shown without a percentage.

The corner [artwork](../desktop/manuscript-corner.webp) was generated with ImageGen and scaled to a transparent 320-pixel WebP with FFmpeg. The four corners reuse this one asset.

<details>
<summary>Manuscript ornament prompt</summary>

Create one isolated L-shaped upper-left corner ornament for a medieval illuminated manuscript border. A hand-inked hawthorn vine with dark oak-green acanthus leaves, three small crimson berry clusters, and slender burnished ochre-gold curlicues. Strong woodcut black outlines, flat pigment and fine hatch marks. Equal horizontal and vertical tapered arms grow from the upper-left corner narrowly along the top and left edges of a square. Keep the lower right three quarters completely transparent. Designed to be legible at a small screen size on warm parchment. No paper, text, letters, frame rules, background, shadow or UI.

</details>

### Automatic profile selection

The verified Windows review ZIP and the released v2.7 selector each downloaded seven MP4s from the same generated DASH sources. FFprobe compared both saved streams with the selected input tracks, including dimensions, codec configuration and the ordered SHA-256 hashes of every encoded packet.

| Source offering | Profile | Height cap | Video saved | Audio saved |
|---|---|---|---|---|
| Separate streams | Compatible MP4 | Best available | 360p H.264 | AAC |
| Separate streams | Maximum Quality | Best available | 1080p AV1 | Opus |
| Separate streams | Maximum Quality | 720p | 720p VP9 | Opus |
| Separate streams | Maximum Quality | 360p | 360p H.264 | Opus |
| Combined files only | Compatible MP4 | Best available | 360p H.264 | AAC |
| Combined files only | Maximum Quality | Best available | 1080p AV1 | Opus |
| Only VP9 and Opus available | Maximum Quality | Best available | 720p VP9 | Opus |

The profile fixture serves one-second generated tracks over loopback. Its generator is checked in beside the inputs so the test can exercise VP9 and AV1 remuxing on platforms that lack those encoders. Profile choice and resolution caps apply to the tracks available from each source.

The [platform run at `9197d02`](https://github.com/landonrivers/LVOVD/actions/runs/45084520590) passed all seven cases on Windows x64, Linux x64 and both macOS architectures. The Windows job repeated them through the extracted release-profile ZIP. Preview disabled Compatible MP4 for the VP9/Opus-only source.

The resolution fixture advertises eleven distinct heights from 144p to 8640p. The options change when switching between profiles or between Video + Audio and Video Only. A direct source with unknown dimensions offers only the uncapped choice. Audio Only and Extras Only clear the cap from the request.

A local run of the extracted Windows release build from `1265be5` verified all four menus and nine saved outputs. The seven video cases above matched the expected source packets. Switching away from a 144p cap saved the original Opus packets for Source Audio and a single JSON file for Extras Only. The ZIP SHA-256 was `b5af9f48ac635e2a0b2174219a98a41d8205caf01ec802e2002987311d1364dd`.

The [four platform gates at `0ceee41`](https://github.com/landonrivers/LVOVD/actions/runs/45335550539) passed the compact Download and Local Media checks, the radio choices and the resolution cases. The [Windows package job](https://github.com/landonrivers/LVOVD/actions/runs/45335550539/job/138246891605) also passed all nine profile and resolution outputs and the four chapter/caption fixture outputs. The register records single-media resolution as Verified. Playlist resolution presets remain part of 8D.3.
