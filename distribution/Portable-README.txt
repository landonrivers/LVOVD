LVOVD Windows x64 development preview

Extract the complete ZIP into its own folder and open lvovd.exe. Keep tools
and prerequisites beside the application. If Evergreen WebView2 is missing,
LVOVD offers the bundled Microsoft offline installer for your account.

The application uses the shared Microsoft Edge WebView2 Runtime under
Microsoft's terms: https://developer.microsoft.com/microsoft-edge/webview2/
Windows may ask you to review an unrecognized application. Check the ZIP's
SHA-256 against the review receipt before opening it.

Runtime tools

The Node 24 executable runs yt-dlp provider scripts. The official yt-dlp
distribution includes its matching EJS scripts. Versions, source URLs and
vendor digests are recorded in provider-tools.json. The tools are separate
programs with their respective licenses.

notices/ includes licenses, component inventories, FFmpeg's configuration
and the Rust lockfile. sources/ includes the yt-dlp source release, FFmpeg,
x264, LAME, Opus and zlib sources, patches and the vcpkg build recipe. For
the exact vcpkg revision see sources/media-tools/vcpkg.json. The complete
LVOVD source is at https://github.com/landonrivers/LVOVD. The package
manifest identifies the code revision, build profile and file hashes.
