# Windows portable review build

The 8D.1 Actions job builds a Windows x64 ZIP for review. On the workflow run, download **LVOVD-Windows-x64-review**. Open the Actions artifact to find the inner `LVOVD-Windows-x64-review.zip`, its SHA-256 and the smoke-test receipt. Compute the hash of the inner ZIP with `Get-FileHash`, compare it with the receipt, and extract the complete inner ZIP to a folder. Double-click **lvovd.exe**. An unrecognized-publisher prompt is possible on a developer preview.

The application opens its own window. On machines missing Evergreen WebView2, the executable offers the official Microsoft offline installer, verifies its size and SHA-256, and waits for a per-user installation. Declining returns to Windows. The user can reopen the app later. The installer can be blocked by organization policy. Existing Evergreen installations continue to receive updates under Microsoft's policy. [Microsoft's Evergreen deployment guide](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

## Build and verify locally

Use PowerShell 7 on a Windows x64 workstation with Git, Node 24, the repository Rust toolchain and the Visual C++ desktop build tools. The first build downloads the pinned components and builds FFmpeg from source. Use a checkout/build path without spaces for the vcpkg FFmpeg build. The extracted application runs from paths with spaces.

```powershell
./scripts/package-windows.ps1
./scripts/test-windows-portable.ps1
```

The ZIP, hash and direct-launch receipt are under `outputs/windows-portable`. The smoke test checks every included file, opens the extracted program with a system-only PATH from another working directory, checks for the named window and an application TCP listener, then closes the window normally. The Actions job additionally drives the release window via Windows accessibility, previews and downloads a synthetic HTTP fixture, and checks the saved audio and video streams using the packaged FFprobe. The fixture server runs in the test harness. The release executable contains no test driver.

## What goes into the ZIP

| Component | Provenance and checks |
|---|---|
| LVOVD | Cargo.lock and the pinned Rust toolchain, release profile, statically linked Windows C runtime. The manifest identifies the revision and whether the build used local changes. |
| FFmpeg and FFprobe | The pinned vcpkg registry builds FFmpeg, x264, LAME, Opus, and zlib from verified sources. The Windows binaries link those libraries statically. The build rejects nonfree configurations and checks the required encoders. Sources, patches, triplet, build recipe, configuration, SPDX records and notices accompany the executables. |
| yt-dlp | Official native nightly executable for the pinned release. The ZIP contains the matching source archive and third-party notices from the same Windows release. |
| Node | Official Node 24 x64 executable for yt-dlp provider scripts, accompanied by the upstream license. The packaged application opens without a system Node installation. |
| Evergreen | Version-specific Microsoft offline installer. Packaging checks both its pinned SHA-256 and Microsoft Authenticode signature. The exact installer version remains an install-time baseline for the shared Evergreen runtime. |

The version pins, digests and Evergreen URL are in [provider-tools.json](../distribution/provider-tools.json). Node digests come from the version's official SHASUMS256 manifest, and yt-dlp digests come from the matching GitHub release. Updating inputs requires changing those pins and rerunning the real download and package tests. [Node downloads](https://nodejs.org/dist/) · [yt-dlp nightly releases](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases) · [yt-dlp EJS packaging](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

Five Cargo archives omit their project license text. The package supplements the notices for alloc-stdlib, selectors and the three webview2-com crates using the upstream texts. The inventory fails when a new shipped crate lacks a notice. [Dropbox BSD license](https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE) · [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/) · [webview2-rs MIT license](https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE)

The package does not establish Windows 10/11 clean-machine compatibility, missing-Evergreen installation, cross-platform distribution, updates or stable-release readiness. Record a successful clean-machine run with the actual ZIP hash, operating system and runtime version before claiming those gates. Review artifacts are separate from release publication.
