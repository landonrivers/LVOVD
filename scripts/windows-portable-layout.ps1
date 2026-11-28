# Inspect the packaged Preview using the same physical coordinates as UI Automation.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$AppPid, [uri]$FixtureUrl, [switch]$RequireExact)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (-not ('LvovdLayout' -as [type])) {
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LvovdLayout {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int size; public Rect monitor, work; public uint flags; }
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", EntryPoint="GetMonitorInfoW", SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    public static Rect WorkArea(IntPtr hwnd) {
        var info = new MonitorInfo { size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info)) throw new Win32Exception();
        return info.work;
    }
    public static Rect Frame(IntPtr hwnd) {
        Rect rect;
        if (!GetWindowRect(hwnd, out rect)) throw new Win32Exception();
        return rect;
    }
    public static void Position(IntPtr hwnd, int x, int y, int width, int height) {
        if (!SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, 0x0014)) throw new Win32Exception();
    }
}
'@
}
function Get-Rect($Raw) {
    [Windows.Rect]::new($Raw.left, $Raw.top, $Raw.right - $Raw.left, $Raw.bottom - $Raw.top)
}
function Get-Bounds($Rect) {
    [ordered]@{ x = $Rect.X; y = $Rect.Y; width = $Rect.Width; height = $Rect.Height }
}
function Get-LayoutTargets($Area, [switch]$Exact) {
    $previous = $null
    foreach ($size in @(@(1280,720), @(960,640))) {
        $width = [int][Math]::Min([double]$size[0], $Area.Width)
        $height = [int][Math]::Min([double]$size[1], $Area.Height)
        $target = [pscustomobject]@{ requestedWidth = $size[0]; requestedHeight = $size[1]; width = $width; height = $height
            constrained = ($width -ne $size[0] -or $height -ne $size[1]) }
        if (($Exact -and $target.constrained) -or ($previous -and $width -eq $previous.width -and $height -eq $previous.height)) {
            throw "Cannot test distinct requested window sizes on work area $Area. Requested $($size[0])x$($size[1]), available ${width}x${height}."
        }
        $target
        $previous = $target
    }
}
function Wait-Control($Root, $Name, $Type) {
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type))
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $item = $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($item -and $item.Current.IsEnabled) { return $item }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for '$Name' in LVOVD process $AppPid."
}
$app = Get-Process -Id $AppPid
$hwnd = $app.MainWindowHandle
if ($app.ProcessName -ne 'lvovd' -or $hwnd -eq [IntPtr]::Zero) { throw "Process $AppPid has no LVOVD window." }
$previousContext = [LvovdLayout]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if ($previousContext -eq [IntPtr]::Zero) { throw 'Could not enable per-monitor DPI-aware test coordinates.' }
try {
    $window = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $pattern = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
    if ($pattern.Current.WindowVisualState -ne [Windows.Automation.WindowVisualState]::Normal) {
        $pattern.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal)
    }
    $buttonType = [Windows.Automation.ControlType]::Button
    if ($FixtureUrl) {
        if ($FixtureUrl.AbsoluteUri -cnotmatch '^http://127\.0\.0\.1:[0-9]+/fixture\.mp4$') { throw 'Expected the generated loopback MP4 fixture.' }
        $input = Wait-Control $window 'Video URL' ([Windows.Automation.ControlType]::Edit)
        $input.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($FixtureUrl.AbsoluteUri)
        (Wait-Control $window 'Preview' $buttonType).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
    $download = Wait-Control $window 'Download Video' $buttonType
    [void](Wait-Control $window 'Choose Media Files' $buttonType)
    $area = Get-Rect ([LvovdLayout]::WorkArea($hwnd))
    $dpi = [LvovdLayout]::GetDpiForWindow($hwnd)
    if (!$dpi -or $area.Width -le 0 -or $area.Height -le 0) { throw "Unusable monitor work area $area or DPI $dpi." }
    foreach ($target in (Get-LayoutTargets $area -Exact:$RequireExact)) {
        $width = $target.width
        $height = $target.height
        $x = $area.X + [Math]::Floor(($area.Width - $width) / 2)
        $y = $area.Y + [Math]::Floor(($area.Height - $height) / 2)
        [LvovdLayout]::Position($hwnd, $x, $y, $width, $height)
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        $lastAction = $null
        $stable = 0
        do {
            $frame = Get-Rect ([LvovdLayout]::Frame($hwnd))
            $action = $download.Current.BoundingRectangle
            $fits = $frame.Width -eq $width -and $frame.Height -eq $height -and $area.Contains($frame) -and
                !$action.IsEmpty -and $action.Width -gt 0 -and $action.Height -gt 0 -and $frame.Contains($action) -and !$download.Current.IsOffscreen
            if ($fits -and $action.Equals($lastAction)) { $stable++ } else { $stable = 0 }
            if ($stable -ge 2) { break }
            $lastAction = $action
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        $requested = "$($target.requestedWidth)x$($target.requestedHeight)"
        if ($stable -lt 2) { throw "Packaged Download Video layout failed: requested=$requested, target=${width}x${height}, frame=$frame, button=$action, workArea=$area, DPI=$dpi." }
        Write-Host "PASS packaged layout: requested=$requested, observed=$($frame.Width)x$($frame.Height), button=$action, workArea=$area, DPI=$dpi."
        [pscustomobject]@{ requestedWidth = $target.requestedWidth; requestedHeight = $target.requestedHeight; constrainedByWorkArea = $target.constrained
            frame = Get-Bounds $frame; downloadButton = Get-Bounds $action; monitorWorkArea = Get-Bounds $area; dpi = $dpi }
    }
} finally {
    [void][LvovdLayout]::SetThreadDpiAwarenessContext($previousContext)
}
