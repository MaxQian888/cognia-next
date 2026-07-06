<#
.SYNOPSIS
  Build + deploy the Cognia mobile app to a connected Android device and wire up
  Chrome DevTools remote debugging — the full "sync code to real device" loop.

.DESCRIPTION
  Runs, in order:
    1. pnpm mobile:sync      (next build with NEXT_PUBLIC_PLATFORM=mobile, then cap sync)   [skip with -SkipWeb]
    2. gradlew assembleDebug (forces JDK 21 — Capacitor 8 needs source release 21)
    3. adb install -r        (reinstall, keeping app data)
    4. force-stop + relaunch
    5. adb forward tcp:9222 -> the new process's webview_devtools_remote socket

  After it finishes, open chrome://inspect (or http://localhost:9222) to debug the
  live WebView (DOM / Console / Network / Sources).

  Re-run after every code change. For native-only / web-unchanged tweaks pass -SkipWeb
  to skip the (slow) Next.js build and only recompile + redeploy the APK.

.PARAMETER SkipWeb
  Skip step 1 (pnpm mobile:sync). Use when only Gradle/native config changed and out/ is current.

.PARAMETER NoForward
  Skip the DevTools port-forward (step 5).

.PARAMETER DevToolsPort
  Local port for the DevTools forward. Default 9222.

.PARAMETER Serial
  Target a specific device by adb serial (for -s). Omit when only one device is attached.

.PARAMETER AppId
  Android application id. Default com.cognia.mobile.

.EXAMPLE
  pwsh -File mobile/scripts/deploy-android.ps1
.EXAMPLE
  pwsh -File mobile/scripts/deploy-android.ps1 -SkipWeb
#>
[CmdletBinding()]
param(
  [switch]$SkipWeb,
  [switch]$NoForward,
  [int]$DevToolsPort = 9222,
  [string]$Serial,
  [string]$AppId = "com.cognia.mobile"
)

$ErrorActionPreference = "Stop"
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Repo root = two levels up from this script (mobile/scripts/ -> repo).
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AndroidDir = Join-Path $RepoRoot "mobile\android"
$Apk = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "[err] $m" -ForegroundColor Red; exit 1 }

# --- Resolve adb -------------------------------------------------------------
function Find-Adb {
  $c = Get-Command adb -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $roots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") |
           Where-Object { $_ }
  foreach ($r in $roots) {
    $p = Join-Path $r "platform-tools\adb.exe"
    if (Test-Path $p) { return $p }
  }
  Die "adb not found. Install Android platform-tools or set ANDROID_HOME."
}

# --- Resolve a JDK 21 home (Capacitor 8 compiles to source release 21) -------
function Find-Jdk21 {
  foreach ($cand in @($env:JAVA_HOME_21, $env:JAVA_HOME)) {
    if ($cand -and (Test-Path (Join-Path $cand "bin\javac.exe"))) {
      $v = & (Join-Path $cand "bin\java.exe") -version 2>&1 | Out-String
      if ($v -match 'version "21') { return $cand }
    }
  }
  $globs = @(
    "C:\Program Files\Microsoft\jdk-21*",
    "C:\Program Files\Eclipse Adoptium\jdk-21*",
    "C:\Program Files\Java\jdk-21*",
    "C:\Program Files\Android\Android Studio\jbr"
  )
  foreach ($g in $globs) {
    $hit = Get-ChildItem -Path $g -Directory -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending | Select-Object -First 1
    if ($hit -and (Test-Path (Join-Path $hit.FullName "bin\javac.exe"))) {
      $v = & (Join-Path $hit.FullName "bin\java.exe") -version 2>&1 | Out-String
      if ($v -match 'version "21' -or $g -like "*jbr*") { return $hit.FullName }
    }
  }
  Die "No JDK 21 found. Install one (e.g. Microsoft OpenJDK 21) or set JAVA_HOME_21."
}

$Adb = Find-Adb
$adbArgs = @()
if ($Serial) { $adbArgs += @("-s", $Serial) }

# --- Pre-flight: a device must be attached ----------------------------------
$devices = & $Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" }
if (-not $devices) { Die "No Android device attached (adb devices is empty). Plug in + allow USB debugging." }
Ok ("device(s): " + (($devices | ForEach-Object { ($_ -split '\s')[0] }) -join ", "))

# --- 1. Web build + cap sync -------------------------------------------------
if ($SkipWeb) {
  Info "skipping web build (-SkipWeb)"
} else {
  Info "pnpm mobile:sync (next build + cap sync)"
  Push-Location $RepoRoot
  try { pnpm mobile:sync; if ($LASTEXITCODE -ne 0) { Die "pnpm mobile:sync failed" } }
  finally { Pop-Location }
  Ok "web assets synced into android/"
}

# --- 2. Gradle assembleDebug with JDK 21 ------------------------------------
$Jdk21 = Find-Jdk21
Info "gradlew assembleDebug (JAVA_HOME=$Jdk21)"
Push-Location $AndroidDir
try {
  $env:JAVA_HOME = $Jdk21
  & .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) { Die "gradle assembleDebug failed" }
} finally { Pop-Location }
if (-not (Test-Path $Apk)) { Die "APK not found at $Apk" }
Ok ("APK: " + $Apk + " (" + [math]::Round((Get-Item $Apk).Length / 1MB, 1) + " MB)")

# --- 3. Install --------------------------------------------------------------
Info "adb install -r"
& $Adb @adbArgs install -r $Apk | Out-Null
if ($LASTEXITCODE -ne 0) { Die "adb install failed" }
Ok "installed $AppId"

# --- 4. Relaunch -------------------------------------------------------------
Info "relaunch"
& $Adb @adbArgs shell am force-stop $AppId | Out-Null
& $Adb @adbArgs shell monkey -p $AppId -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 3
$pidStr = (& $Adb @adbArgs shell pidof $AppId).Trim()
if (-not $pidStr) { Die "app did not start (no pid for $AppId)" }
$ProcPid = ($pidStr -split '\s')[0]
Ok "running, pid=$ProcPid"

# --- 5. DevTools forward -----------------------------------------------------
if ($NoForward) {
  Info "skipping DevTools forward (-NoForward)"
} else {
  & $Adb @adbArgs forward --remove "tcp:$DevToolsPort" 2>$null | Out-Null
  & $Adb @adbArgs forward "tcp:$DevToolsPort" "localabstract:webview_devtools_remote_$ProcPid" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Ok "DevTools ready -> http://localhost:$DevToolsPort  (or chrome://inspect)"
  } else {
    Write-Host "[warn] DevTools forward failed (WebView socket not up yet?). Retry: $Adb forward tcp:$DevToolsPort localabstract:webview_devtools_remote_$ProcPid" -ForegroundColor Yellow
  }
}

$sw.Stop()
Write-Host ""
Ok ("done in {0:N0}s. Live logs: {1} logcat --pid={2} -v time | findstr /i `"Capacitor Console error`"" -f $sw.Elapsed.TotalSeconds, $Adb, $ProcPid)
