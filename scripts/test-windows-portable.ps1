[CmdletBinding()]
param([switch]$Download)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/..").Path
$out = "$root/outputs/windows-portable"
$zip = "$out/LVOVD-Windows-x64-review.zip"
$sha = (Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant()
if ($sha -ne ((Get-Content -Raw -LiteralPath "$zip.sha256") -split ' ')[0]) { throw 'ZIP checksum mismatch.' }
$scratch = Join-Path $out ("unpacked-" + [guid]::NewGuid())
[IO.Compression.ZipFile]::ExtractToDirectory($zip,$scratch)
$manifest = Get-Content -Raw -LiteralPath "$scratch/package-manifest.json" | ConvertFrom-Json
if ($manifest.target -ne 'x86_64-pc-windows-msvc' -or $manifest.profile -ne 'release') { throw 'Unexpected build type.' }
$entries = @(Get-ChildItem -LiteralPath $scratch -File -Recurse)
if ($entries.Count -ne (1 + $manifest.files.Count)) { throw 'Unexpected files in ZIP.' }
foreach ($file in $manifest.files) {
    $path = Join-Path $scratch $file.path
    if ((Get-Item -LiteralPath $path).Length -ne $file.size -or (Get-FileHash -LiteralPath $path).Hash -ne $file.sha256) { throw "Package integrity failure for $($file.path)." }
}
if (Get-Process -Name lvovd -ErrorAction SilentlyContinue) { throw 'Close the existing LVOVD window before testing its single-instance launch.' }
if ($Download) {
    if (!$env:GITHUB_ACTIONS) { throw 'Use an isolated Actions account for the fixture saved in Downloads.' }
    # Fresh hosted images can expose the standard Known Folder before its
    # backing directory exists. Create it for this test user before app launch.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PortableTestFolders {
    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    public static string Downloads() {
        Guid id = new Guid("374DE290-123F-4565-9164-39C4925E467B");
        IntPtr path;
        Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id, 0x8000, IntPtr.Zero, out path));
        try { return Marshal.PtrToStringUni(path); }
        finally { Marshal.FreeCoTaskMem(path); }
    }
}
'@
    $downloadDirectory = [PortableTestFolders]::Downloads()
    if (!(Test-Path -LiteralPath $downloadDirectory -PathType Container)) { throw 'Cannot prepare the runner Downloads folder.' }
}
$limits = [Diagnostics.ProcessStartInfo]::new("$scratch/lvovd.exe")
$limits.WorkingDirectory = $out
$limits.UseShellExecute = $false
$limits.Environment['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
foreach ($key in @($limits.Environment.Keys | Where-Object { $_ -like 'LVOVD_*' -or $_ -like 'WEBVIEW2_*' -or $_ -in 'NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','CARGO_HOME','RUSTUP_HOME' })) { [void]$limits.Environment.Remove($key) }
$viewer = [Diagnostics.Process]::Start($limits)
$details = [ordered]@{ commit = $manifest.commit; pullRequestHead = $manifest.pullRequestHead; workingTreeModified = $manifest.workingTreeModified; profile = $manifest.profile; target = $manifest.target; archiveSha256 = $sha; os = [Environment]::OSVersion.VersionString; nativeWindow = $false; applicationTcpListeners = $null; fixtureDownload = $false; toolVersions = [ordered]@{} }
try {
    $probes = [ordered]@{ 'ffmpeg' = @('-version'); 'ffprobe' = @('-version'); 'node' = @('--version'); 'yt-dlp' = @('--ignore-config','--no-plugin-dirs','--version') }
    foreach ($name in $probes.Keys) {
        $probe = [Diagnostics.ProcessStartInfo]::new("$scratch/tools/$name.exe")
        $probe.UseShellExecute = $false
        $probe.WorkingDirectory = $out
        $probe.RedirectStandardOutput = $true
        $probe.RedirectStandardError = $true
        $probe.Environment.Clear()
        foreach ($key in $limits.Environment.Keys) { $probe.Environment[$key] = $limits.Environment[$key] }
        foreach ($argument in $probes[$name]) { $probe.ArgumentList.Add($argument) }
        $tool = [Diagnostics.Process]::Start($probe)
        try {
            $output = $tool.StandardOutput.ReadToEndAsync()
            $diagnostic = $tool.StandardError.ReadToEndAsync()
            if (!$tool.WaitForExit(15000) -or $tool.ExitCode -ne 0) { throw "The packaged $name version probe failed." }
            $details.toolVersions[$name] = ($output.Result -split '\r?\n')[0]
            [void]$diagnostic.Result
        } finally {
            if (!$tool.HasExited) { $tool.Kill($true) }
            $tool.Dispose()
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 250
        $viewer.Refresh()
        if ($viewer.HasExited) { throw 'The extracted application exited before opening its window.' }
    } until (($viewer.MainWindowHandle -ne 0 -and $viewer.MainWindowTitle -eq 'LVOVD') -or [DateTime]::UtcNow -gt $deadline)
    if ($viewer.MainWindowHandle -eq 0 -or $viewer.MainWindowTitle -ne 'LVOVD') { throw 'The native LVOVD window did not open.' }
    $details.nativeWindow = $true
    $listeners = @(Get-NetTCPConnection -State Listen | Where-Object OwningProcess -eq $viewer.Id)
    $details.applicationTcpListeners = $listeners.Count
    if ($listeners.Count) { throw 'The packaged host opened a TCP listener.' }
    if ($Download) {
        # Windows PowerShell provides the Windows UI Automation assemblies. Drive
        # the real accessibility tree. No debugger or test controls enter LVOVD.
        & powershell.exe -NoProfile -NonInteractive -File "$PSScriptRoot/windows-portable-download.ps1" -AppPid $viewer.Id -Tools "$scratch/tools" -Working "$out" -Destination $downloadDirectory
        if ($LASTEXITCODE) { throw 'Packaged Download acceptance failed.' }
        $details.fixtureDownload = $true
    }
    if (!$viewer.CloseMainWindow() -or !$viewer.WaitForExit(30000)) { throw 'The application did not close normally.' }
    $details | ConvertTo-Json | Set-Content -Encoding utf8 "$out/receipt.json"
} finally {
    if (!$viewer.HasExited) { $viewer.Kill($true); $viewer.WaitForExit() }
    $viewer.Dispose()
}
