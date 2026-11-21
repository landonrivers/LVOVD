# Build from the checksum-pinned upstream sources in the locked vcpkg registry.
[CmdletBinding()]
param([string]$Destination, [switch]$IncludeSources)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/..").Path
$cache = "$root/outputs/portable-inputs"
$recipe = "$root/distribution/media-tools"
$revision = (Get-Content -Raw -LiteralPath "$recipe/vcpkg.json" | ConvertFrom-Json).'builtin-baseline'
if (!$Destination) { $Destination = "$root/outputs/native-tools" }
$registry = "$cache/vcpkg"
$install = "$cache/installed"
$tools = Join-Path $Destination tools
New-Item -ItemType Directory -Force -Path $registry,$tools | Out-Null
if (!(Test-Path -LiteralPath "$registry/.git")) {
    & git -C $registry init --quiet
    if ($LASTEXITCODE) { throw 'Could not initialize the private build registry.' }
    & git -C $registry fetch --quiet --depth=1 https://github.com/microsoft/vcpkg.git $revision
    if ($LASTEXITCODE) { throw 'Could not fetch the pinned vcpkg registry.' }
    & git -C $registry checkout --quiet --detach $revision
    if ($LASTEXITCODE) { throw 'Could not check out the pinned vcpkg registry.' }
}
if ((& git -C $registry rev-parse HEAD) -ne $revision -or (& git -C $registry status --porcelain --untracked-files=no)) {
    throw 'The build registry does not match the pinned revision. Use a fresh outputs/portable-inputs/vcpkg directory.'
}
if ($IsWindows) {
    $triplet = 'lvovd-x64-windows'
    $suffix = '.exe'
    & "$registry/bootstrap-vcpkg.bat" -disableMetrics
} else {
    $suffix = ''
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $osName = if ($IsMacOS) { 'osx' } else { 'linux' }
    $triplet = "$arch-$osName"
    & "$registry/bootstrap-vcpkg.sh" -disableMetrics
}
if ($LASTEXITCODE) { throw 'Could not bootstrap the pinned build tool.' }
$binarySource = '--no-binarycaching'
if ($env:GITHUB_ACTIONS) {
    # Use only this job's ABI-keyed cache. Local and fresh builds compile the
    # locked sources. Distribution still verifies the actual source archives.
    $binaries = "$cache/binary-cache"
    New-Item -ItemType Directory -Force $binaries | Out-Null
    $binarySource = "--binarysource=clear;files,$binaries,readwrite"
}
& "$registry/vcpkg$suffix" install "--x-manifest-root=$recipe" "--overlay-triplets=$recipe/triplets" "--triplet=$triplet" "--x-install-root=$install" $binarySource --disable-metrics
if ($LASTEXITCODE) { throw 'Could not build the pinned media tools.' }
foreach ($tool in 'ffmpeg','ffprobe') { Copy-Item -LiteralPath "$install/$triplet/tools/ffmpeg/$tool$suffix" -Destination $tools }
$version = & "$tools/ffmpeg$suffix" -version
if ($LASTEXITCODE -or ($version -join ' ') -match '--enable-nonfree' -or ($version -join ' ') -notmatch '--enable-libx264') { throw 'The media build does not match the approved configuration.' }
$encoders = & "$tools/ffmpeg$suffix" -hide_banner -encoders
if ($LASTEXITCODE) { throw 'Cannot inspect encoder capabilities.' }
foreach ($required in 'libx264','aac','libmp3lame','libopus','flac','pcm_s24le') {
    if (!($encoders -match "\s$required\s")) { throw "The media build is missing the $required encoder." }
}
$muxers = & "$tools/ffmpeg$suffix" -hide_banner -muxers
if ($LASTEXITCODE) { throw 'Cannot inspect muxer capabilities.' }
foreach ($required in 'mp4','mov','matroska','ipod','mp3','ogg','flac','wav') {
    if (!($muxers -match "\s$required\s")) { throw "The media build is missing the $required muxer." }
}
if ($IncludeSources) {
    $sources = Join-Path $Destination sources
    $notices = Join-Path $Destination notices
    New-Item -ItemType Directory -Force -Path $sources,$notices,"$sources/ports" | Out-Null
    $archives = @{}
    foreach ($archive in Get-ChildItem -LiteralPath "$registry/downloads" -File | Where-Object Name -Match '\.tar\.(gz|xz|bz2)$') {
        $archives[(Get-FileHash -Algorithm SHA512 -LiteralPath $archive.FullName).Hash.ToLowerInvariant()] = $archive
    }
    foreach ($port in 'ffmpeg','mp3lame','opus','x264','zlib') {
        $share = "$install/$triplet/share/$port"
        $portRecipe = Get-Content -Raw -LiteralPath "$registry/ports/$port/portfile.cmake"
        $pin = [regex]::Match($portRecipe, 'SHA512\s+([0-9a-f]{128})').Groups[1].Value
        if (!$pin -or !$archives.ContainsKey($pin)) { throw "Missing verified corresponding source for $port." }
        Copy-Item -LiteralPath $archives[$pin].FullName -Destination $sources
        Copy-Item -LiteralPath "$registry/ports/$port" -Recurse -Destination "$sources/ports"
        Copy-Item -LiteralPath "$share/copyright" -Destination "$notices/$port.txt"
        Copy-Item -LiteralPath "$share/vcpkg.spdx.json" -Destination "$notices/$port.spdx.json"
    }
    Copy-Item -LiteralPath $recipe -Recurse -Destination $sources
    Copy-Item -LiteralPath "$registry/LICENSE.txt" -Destination "$notices/vcpkg-LICENSE.txt"
    Copy-Item -LiteralPath $PSCommandPath -Destination $sources
    $version | Set-Content -Encoding utf8 "$notices/FFmpeg-build.txt"
}
