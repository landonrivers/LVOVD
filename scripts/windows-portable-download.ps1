# CI-only accessibility test of the unmodified release-profile ZIP. The fixture
# server belongs to the test harness and is never included in the application.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$AppPid,[Parameter(Mandatory)][string]$Tools,[Parameter(Mandatory)][string]$Working,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
if (!$env:GITHUB_ACTIONS) { throw 'Use an isolated Actions runner with a dedicated Downloads folder.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$fixture = Join-Path $Working 'controlled-input.mp4'
& "$Tools/ffmpeg.exe" -nostdin -loglevel error -y -f lavfi -i testsrc2=size=64x64:rate=8 -f lavfi -i sine=frequency=440 -t 1 -c:v libx264 -c:a aac $fixture
if ($LASTEXITCODE) { throw 'Could not generate the controlled fixture.' }
$ready = Join-Path $Working ("fixture-" + [guid]::NewGuid() + '.json')
$runner = (Get-Command node.exe).Source
$argsLine = '"{0}" "{1}" "{2}"' -f "$PSScriptRoot/windows-provider-fixture.cjs", $fixture, $ready
$server = Start-Process -FilePath $runner -ArgumentList $argsLine -WindowStyle Hidden -PassThru
function Wait-Element($Window, $Name, $Type, $Seconds) {
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$Type))
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $match = $Window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
        if ($match -and $match.Current.IsEnabled) { return $match }
        Start-Sleep -Milliseconds 200
    } until ([DateTime]::UtcNow -gt $deadline)
    throw "Timed out waiting for the native control '$Name'."
}
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!(Test-Path -LiteralPath $ready)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Controlled provider did not start.' }
        Start-Sleep -Milliseconds 100
    }
    $before = @(Get-ChildItem -LiteralPath $Destination -File | ForEach-Object FullName)
    $window = [Windows.Automation.AutomationElement]::FromHandle((Get-Process -Id $AppPid).MainWindowHandle)
    $url = (Get-Content -Raw -LiteralPath $ready | ConvertFrom-Json).url
    $input = Wait-Element $window 'Video URL' ([Windows.Automation.ControlType]::Edit) 40
    $input.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($url)
    foreach ($action in 'Preview','Download Video') {
        $button = Wait-Element $window $action ([Windows.Automation.ControlType]::Button) 90
        $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
    [void](Wait-Element $window 'Open File' ([Windows.Automation.ControlType]::Button) 90)
    $saved = @(Get-ChildItem -LiteralPath $Destination -File -Filter '*.mp4' | Where-Object { $before -notcontains $_.FullName })
    if ($saved.Count -ne 1) { throw 'Expected one new video in the captured output folder.' }
    $streams = & "$Tools/ffprobe.exe" -v error -show_entries stream=codec_type -of json $saved[0].FullName
    if ($LASTEXITCODE) { throw 'FFprobe could not inspect the saved file.' }
    $types = (($streams | Out-String | ConvertFrom-Json).streams.codec_type | Sort-Object) -join ','
    if ($types -ne 'audio,video') { throw 'The saved file must contain playable audio and video.' }
    & "$Tools/ffmpeg.exe" -nostdin -v error -xerror -protocol_whitelist file -i $saved[0].FullName -map 0:v:0 -map 0:a:0 -f null -
    if ($LASTEXITCODE) { throw 'The packaged media tool could not decode the saved video and audio completely.' }
} finally {
    if (!$server.HasExited) { $server.Kill(); $server.WaitForExit() }
}
