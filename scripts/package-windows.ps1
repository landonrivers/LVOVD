# Assemble a review artifact. No release, update metadata, installer or upload.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Build the Windows x64 review package on Windows x64.' }
$root = (Resolve-Path "$PSScriptRoot/..").Path
$out = "$root/outputs/windows-portable"
$payload = "$out/build-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Force $payload | Out-Null
$triplet = 'x86_64-pc-windows-msvc'
$oldTarget = $env:CARGO_TARGET_DIR
$oldFlags = $env:CARGO_ENCODED_RUSTFLAGS
try {
    # Link the Microsoft C runtime statically so a developer redistributable
    # installed on the build machine cannot become a hidden user prerequisite.
    $env:CARGO_TARGET_DIR = "$root/target"
    $env:CARGO_ENCODED_RUSTFLAGS = '-Ctarget-feature=+crt-static'
    & node "$root/scripts/desktop.cjs" build --release --target $triplet
    if ($LASTEXITCODE) { throw 'Locked release-profile build failed.' }
    & node "$root/scripts/desktop.cjs" test-host --release --target $triplet evergreen::tests
    if ($LASTEXITCODE) { throw 'Evergreen prerequisite tests failed.' }
} finally {
    $env:CARGO_ENCODED_RUSTFLAGS = $oldFlags
    $env:CARGO_TARGET_DIR = $oldTarget
}
Copy-Item -LiteralPath "$root/target/$triplet/release/lvovd.exe" -Destination $payload
& "$PSScriptRoot/desktop-media-tools.ps1" -Destination $payload -IncludeSources
& "$PSScriptRoot/desktop-provider-tools.ps1" -Destination $payload -IncludeEvergreen
Copy-Item -LiteralPath "$root/LICENSE","$root/NOTICE","$root/distribution/provider-tools.json","$root/distribution/Portable-README.txt" -Destination $payload
Copy-Item -LiteralPath "$root/Cargo.lock" -Destination "$payload/notices"
& node "$PSScriptRoot/desktop-inventory.cjs" "$payload/notices"
if ($LASTEXITCODE) { throw 'Could not record shipped Rust dependencies.' }
$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE) { throw 'Could not identify the source commit.' }
$dirty = [bool](& git -C $root status --porcelain)
if ($env:GITHUB_ACTIONS -and $dirty) { throw 'The review package must be built from a clean source revision in CI.' }
$entries = foreach ($file in Get-ChildItem -File -Recurse -LiteralPath $payload | Sort-Object FullName) {
    [ordered]@{ path = [IO.Path]::GetRelativePath($payload,$file.FullName).Replace('\','/'); size = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{ schema = 1; commit = $commit; pullRequestHead = $env:LVOVD_REVIEW_HEAD_SHA; workingTreeModified = $dirty; target = $triplet; profile = 'release'; files = @($entries) }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$payload/package-manifest.json"
$archive = "$out/LVOVD-Windows-x64-review.zip"
$partial = "$archive.$([Guid]::NewGuid()).partial"
[IO.Compression.ZipFile]::CreateFromDirectory($payload,$partial,[IO.Compression.CompressionLevel]::Fastest,$false)
Move-Item -LiteralPath $partial -Destination $archive -Force
$hash = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant()
"$hash  LVOVD-Windows-x64-review.zip" | Set-Content -Encoding ascii "$archive.sha256"
Write-Host "Windows x64 review ZIP: $archive"
