# Windows PowerShell UI Automation against the running, unmodified portable app.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$AppPid,
    [Parameter(Mandatory)][string]$Tools,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$Receipt,
    [ValidateSet('Fixture','Captions','SponsorBlock')][string]$Scenario='Fixture'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window=[Windows.Automation.AutomationElement]::FromHandle((Get-Process -Id $AppPid).MainWindowHandle)
$scope=[Windows.Automation.TreeScope]::Descendants
$ae=[Windows.Automation.AutomationElement]
$ffmpeg=Join-Path $Tools 'ffmpeg.exe'
$ffprobe=Join-Path $Tools 'ffprobe.exe'
$fixtureScript=Join-Path $PSScriptRoot 'chapter-caption-fixture.cjs'
$evidence=[ordered]@{scenario=$Scenario; outputs=@()}
function Find-Control($Root,$Property,$Value) {
    $Root.FindFirst($scope,[Windows.Automation.PropertyCondition]::new($Property,$Value))
}
function Wait-Control($Property,$Value) {
    $end=[DateTime]::UtcNow.AddSeconds(100)
    do {
        $control=Find-Control $window $Property $Value
        if ($control -and $control.Current.IsEnabled) {return $control}
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $end)
    throw "Packaged window did not expose '$Value'."
}
function ById($Id) {Wait-Control $ae::AutomationIdProperty $Id}
function Invoke-Control($Control) {$Control.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()}
function Set-Text($Id,$Text) {(ById $Id).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Text)}
function Open-Panel($Name) {
    $control=Wait-Control $ae::NameProperty $Name
    $expand=$null
    if ($control.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)) {
        if ($expand.Current.ExpandCollapseState -eq 'Collapsed') {$expand.Expand()}
    } else {Invoke-Control $control}
}
function Select-Choice($Id,$Name) {
    $end=[DateTime]::UtcNow.AddSeconds(20)
    do {
        $select=ById $Id
        $select.SetFocus()
        $expand=$select.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($expand.Current.ExpandCollapseState -ne 'Expanded') {$expand.Expand()}
        Start-Sleep -Milliseconds 250
        $choice=Find-Control $window $ae::NameProperty $Name
        if ($choice -and $choice.Current.IsEnabled) {
            $choice.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
            return
        }
    } while ([DateTime]::UtcNow -lt $end)
    throw "The '$Id' menu did not offer '$Name'."
}
function Check-Choice($Property,$Value,$Checked=$true) {
    $control=Wait-Control $Property $Value
    $toggle=$control.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if (($toggle.Current.ToggleState -eq 'On') -ne $Checked) {$toggle.Toggle()}
}
function Preview($Url) {
    Set-Text 'download-url' $Url
    Invoke-Control (ById 'download-preview-button')
    [void](ById 'dl-content')
}
function Count-Named($Name) {
    $window.FindAll($scope,[Windows.Automation.PropertyCondition]::new($ae::NameProperty,$Name)).Count
}
function Save-Selection([int]$Expected) {
    $before=@(Get-ChildItem -LiteralPath $Destination -File | ForEach-Object FullName)
    $saved=Count-Named 'Open File'
    $failed=Count-Named 'Failed'
    Invoke-Control (ById 'download-start')
    $end=[DateTime]::UtcNow.AddMinutes(5)
    do {
        if ((Count-Named 'Open File') -gt $saved) {break}
        if ((Count-Named 'Failed') -gt $failed) {
            if ($Expected -eq 0) {break}
            throw 'Packaged acquisition failed before saving the selected outputs.'
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $end)
    if ([DateTime]::UtcNow -ge $end) {throw 'Packaged download did not reach its terminal state.'}
    $new=@(Get-ChildItem -LiteralPath $Destination -File | Where-Object {$before -notcontains $_.FullName} | Sort-Object Name)
    if ($new.Count -ne $Expected) {throw "Expected $Expected new files, got $($new.Count)."}
    $new | ForEach-Object FullName
}
function Set-Captions($Mode,$Language) {
    Select-Choice 'dl-content' 'Extras Only'
    Check-Choice $ae::AutomationIdProperty 'dl-subs'
    Select-Choice 'dl-submode' $Mode
    Set-Text 'dl-langs' $Language
}
function Probe($File) {
    $json=& $ffprobe -v error -show_entries 'stream=codec_type,codec_name:format=duration:chapter=start_time,end_time:chapter_tags=title' -of json $File
    if ($LASTEXITCODE) {throw 'FFprobe could not read a saved output.'}
    $json | Out-String | ConvertFrom-Json
}
function Record-File($Mode,$File) {
    $evidence.outputs+=@{mode=$Mode;extension=[IO.Path]::GetExtension($File);bytes=(Get-Item -LiteralPath $File).Length}
}
function Read-Caption($File) {
    if ($File -notmatch '\.srt$') {throw 'Expected an SRT companion.'}
    $facts=Probe $File
    if ($facts.streams.Count -ne 1 -or $facts.streams[0].codec_name -ne 'subrip') {throw 'FFprobe could not identify a single SRT stream.'}
    $text=[IO.File]::ReadAllText($File).Trim().Replace("`r","")
    if ($text -notmatch '(?m)^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n\S') {throw 'Missing timed SRT text.'}
    return $text
}
if (!(Test-Path -LiteralPath $Destination -PathType Container)) {throw 'A known existing output folder is required.'}
$server=$null
try {
    if ($Scenario -eq 'Fixture') {
        $start=New-Object Diagnostics.ProcessStartInfo
        $start.FileName=(Get-Command node.exe).Source
        $start.Arguments='"{0}" serve "{1}"' -f $fixtureScript,$ffmpeg
        $start.UseShellExecute=$false
        $start.CreateNoWindow=$true
        $start.RedirectStandardInput=$true
        $start.RedirectStandardOutput=$true
        $server=[Diagnostics.Process]::Start($start)
        $ready=$server.StandardOutput.ReadLineAsync()
        if (!$ready.Wait(30000) -or !$ready.Result) {throw 'Chapter fixture did not start.'}
        $urls=$ready.Result | ConvertFrom-Json
        Preview $urls.chapters
        Open-Panel 'Time range and chapters'
        Select-Choice 'dl-range' 'Selected chapters'
        Check-Choice $ae::NameProperty '1. Opening'
        Check-Choice $ae::NameProperty '3. Ending'
        $files=@(Save-Selection 2)
        & node.exe $fixtureScript chapters $ffmpeg $ffprobe @files
        if ($LASTEXITCODE) {throw 'Saved chapter verification failed.'}
        foreach ($file in $files) {Record-File 'chapter' $file}
        Preview $urls.captions
        Set-Captions 'Creator subtitles' 'en,fr'
        $files=@(Save-Selection 2)
        & node.exe $fixtureScript captions @files
        if ($LASTEXITCODE) {throw 'Saved caption verification failed.'}
        foreach ($file in $files) {Record-File 'creator' $file}
        Preview $urls.captions
        Set-Captions 'Creator and automatic' 'zz'
        [void](Save-Selection 0)
        $evidence.unavailableLanguage='Failed without publication'
    } elseif ($Scenario -eq 'Captions') {
        $url=$env:LVOVD_QA_CAPTION_URL
        if (!$url) {throw 'Set LVOVD_QA_CAPTION_URL to a permitted source with creator and automatic English tracks.'}
        foreach ($mode in 'Creator subtitles','Automatic captions','Creator and automatic') {
            Preview $url
            Set-Captions $mode 'en'
            $file=Save-Selection 1
            $cues=Read-Caption $file
            if ($mode -eq 'Creator subtitles') {$creator=$cues}
            if ($mode -eq 'Automatic captions' -and $cues -ceq $creator) {throw 'Fixture did not distinguish the two caption sources.'}
            if ($mode -eq 'Creator and automatic' -and $cues -cne $creator) {throw 'Both mode did not prefer the creator track.'}
            Record-File $mode $file
        }
        $language=$env:LVOVD_QA_AUTO_LANGUAGE
        if (!$language) {throw 'Set LVOVD_QA_AUTO_LANGUAGE to a reviewed language offered only as automatic captions.'}
        foreach ($mode in 'Automatic captions','Creator and automatic') {
            Preview $url
            Set-Captions $mode $language
            $file=Save-Selection 1
            $cues=Read-Caption $file
            if ($mode -eq 'Automatic captions') {$automatic=$cues}
            elseif ($cues -cne $automatic) {throw 'Both mode did not fall back to the automatic track.'}
            Record-File "$mode (automatic-only language)" $file
        }
    } else {
        $url=$env:LVOVD_QA_SPONSOR_URL
        if (!$url) {throw 'Set LVOVD_QA_SPONSOR_URL to a permitted source with a known outro.'}
        $segmentStart=[double]::Parse($env:LVOVD_QA_SEGMENT_START,[cultureinfo]::InvariantCulture)
        $segmentEnd=[double]::Parse($env:LVOVD_QA_SEGMENT_END,[cultureinfo]::InvariantCulture)
        if ($segmentEnd -le $segmentStart) {throw 'Expected independently confirmed segment bounds.'}
        foreach ($mode in 'Off','Mark','Remove') {
            Preview $url
            Select-Choice 'dl-height' '144p'
            if ($mode -ne 'Off') {
                Open-Panel 'SponsorBlock'
                Select-Choice 'dl-sponsor' $mode
                Check-Choice $ae::NameProperty 'Sponsor' $false
                Check-Choice $ae::NameProperty 'Outro'
            }
            $file=Save-Selection 1
            $facts=Probe $file
            # MP4 may carry a chapter data track alongside the audio and video.
            if (@($facts.streams | Where-Object codec_type -eq 'audio').Count -ne 1 -or
                @($facts.streams | Where-Object codec_type -eq 'video').Count -ne 1) {throw 'Missing saved audio or video stream.'}
            $duration=[double]::Parse($facts.format.duration,[cultureinfo]::InvariantCulture)
            $marked=@($facts.chapters | Where-Object {$_.tags.title -match 'SponsorBlock|Endcards|Outro'})
            if ($mode -eq 'Off') {
                $original=$duration
                if ($marked.Count) {throw 'Off unexpectedly annotated this source.'}
            } elseif ($mode -eq 'Mark') {
                if ([Math]::Abs($duration-$original) -gt 1 -or $marked.Count -ne 1 -or
                    [Math]::Abs([double]$marked[0].start_time-$segmentStart) -gt 1 -or
                    [Math]::Abs([double]$marked[0].end_time-$segmentEnd) -gt 1) {throw 'Marked output differed from the independently reviewed outro.'}
            } elseif ([Math]::Abs($duration-($original-($segmentEnd-$segmentStart))) -gt 1 -or $marked.Count) {throw 'Removed output duration or chapters are incorrect.'}
            & $ffmpeg -nostdin -v error -xerror -i $file -map 0:v:0 -map 0:a:0 -f null -
            if ($LASTEXITCODE) {throw 'Saved tracks did not fully decode.'}
            Record-File $mode $file
        }
    }
    $evidence | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -LiteralPath $Receipt
    Write-Output "PASS packaged $Scenario ($($evidence.outputs.Count) validated files)"
} finally {
    if ($server) {
        $server.StandardInput.Close()
        if (!$server.WaitForExit(5000)) {$server.Kill();$server.WaitForExit()}
        $server.Dispose()
    }
}
