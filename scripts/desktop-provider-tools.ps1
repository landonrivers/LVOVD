# Build-time provisioning only. The packaged application never runs this script.
[CmdletBinding()]
param(
    [string]$Destination,
    [switch]$IncludeEvergreen
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/..").Path
$pins = Get-Content -Raw -LiteralPath "$root/distribution/provider-tools.json" | ConvertFrom-Json -AsHashtable
$cache = "$root/outputs/portable-inputs"
if (!$Destination) { $Destination = "$root/outputs/native-tools" }
$tools = Join-Path $Destination tools
$notices = Join-Path $Destination notices
New-Item -ItemType Directory -Force -Path $tools,$notices,$cache | Out-Null
$platform = if ($IsWindows) { 'win32' } elseif ($IsMacOS) { 'darwin' } else { 'linux' }
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$suffix = if ($IsWindows) { '.exe' } else { '' }
$curl = if ($IsWindows) { 'curl.exe' } else { 'curl' }

function Get-PinnedFile($Url, $Name, $Checksum, $MaxBytes) {
    $file = Join-Path $cache $Name
    if ((Test-Path -LiteralPath $file) -and (Get-FileHash -LiteralPath $file).Hash -eq $Checksum) { return $file }
    $partial = "$file.$([Guid]::NewGuid()).partial"
    try {
        & $curl --fail --silent --show-error --location --max-redirs 4 --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 --max-filesize $MaxBytes -o $partial $Url
        if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $partial).Hash -ne $Checksum) { throw "Could not verify $Name. Check its pinned version and SHA-256." }
        Move-Item -LiteralPath $partial -Destination $file -Force
        return $file
    } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial } }
}

$nodeSpec = $pins.node.archives["$platform-$arch"]
if (!$nodeSpec) { throw "There is no pinned provider runtime for $platform-$arch." }
$archiveName = "node-v$($pins.node.version)-$($nodeSpec[0])"
$archive = Get-PinnedFile "https://nodejs.org/dist/v$($pins.node.version)/$archiveName" $archiveName $nodeSpec[1] 100000000
$archiveRoot = $archiveName -replace '\.(zip|tar\.gz|tar\.xz)$',''
$nodeInArchive = if ($IsWindows) { 'node.exe' } else { 'bin/node' }
& tar -xf $archive -C $cache "$archiveRoot/$nodeInArchive" "$archiveRoot/LICENSE"
if ($LASTEXITCODE) { throw 'Could not extract the verified Node archive.' }
Copy-Item -LiteralPath "$cache/$archiveRoot/$nodeInArchive" -Destination "$tools/node$suffix"
Copy-Item -LiteralPath "$cache/$archiveRoot/LICENSE" -Destination "$notices/Node-LICENSE.txt"

$ytSpec = $pins.ytdlp.archives[$platform]
$ytBase = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/$($pins.ytdlp.version)"
$yt = Get-PinnedFile "$ytBase/$($ytSpec[0])" "$($pins.ytdlp.version)-$($ytSpec[0])" $ytSpec[1] 100000000
Copy-Item -LiteralPath $yt -Destination "$tools/yt-dlp$suffix"
if (!$IsWindows) {
    & chmod 755 "$tools/node" "$tools/yt-dlp"
    if ($LASTEXITCODE) { throw 'Could not set executable permissions.' }
}

if ($IncludeEvergreen) {
    if (!$IsWindows -or $arch -ne 'x64') { throw 'The portable package targets Windows x64.' }
    $prereq = Join-Path $Destination prerequisites
    New-Item -ItemType Directory -Force $prereq | Out-Null
    $offline = Get-PinnedFile $pins.evergreen.url 'evergreen.exe' $pins.evergreen.sha256 $pins.evergreen.bytes
    $signature = Get-AuthenticodeSignature -LiteralPath $offline
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { throw 'The Evergreen installer requires a valid Microsoft Authenticode signature.' }
    Copy-Item -LiteralPath $offline -Destination "$prereq/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
    $source = Get-PinnedFile "$ytBase/yt-dlp.tar.gz" "$($pins.ytdlp.version)-yt-dlp.tar.gz" $pins.ytdlp.sourceSha256 25000000
    New-Item -ItemType Directory -Force "$Destination/sources" | Out-Null
    Copy-Item -LiteralPath $source -Destination "$Destination/sources/yt-dlp-$($pins.ytdlp.version).tar.gz"
    $licenseZip = Get-PinnedFile "$ytBase/yt-dlp_win.zip" 'yt-dlp_win.zip' $pins.ytdlp.windowsLicenseArchiveSha256 100000000
    & tar -xf $licenseZip -C $cache _internal/THIRD_PARTY_LICENSES.txt
    if ($LASTEXITCODE) { throw 'Missing yt-dlp third-party notices.' }
    Copy-Item -LiteralPath "$cache/_internal/THIRD_PARTY_LICENSES.txt" -Destination "$notices/yt-dlp-THIRD-PARTY.txt"
}
