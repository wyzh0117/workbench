#requires -Version 7.0
param(
  [string]$Tag = 'v3.1.0',
  [string]$Version = '3.1.0',
  [string]$ExpectedSha256 = 'c165416a082a2686922f90ecd7bf4c924319e7eff89f0bc8aceadb5e5fc72514',
  [long]$ExpectedSize = 5552572L,
  [string]$ExpectedSidecarSha256 = 'b2e727aef2c1f68c0975d53d6697ff0d17f68340b4332055f068466d98f11798',
  [long]$ExpectedSidecarSize = 107L,
  [switch]$RequireIconParity
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$assetName = 'AI-Course-Workbench-Windows-x64-setup.exe'
$versionPattern = '^' + [regex]::Escape($Version) + '(?:\.0)?$'
$releaseBase = "https://github.com/wyzh0117/workbench/releases/download/$Tag"
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'This verification must run in an isolated GitHub Actions runner.'
}

$evidenceDir = Join-Path $env:RUNNER_TEMP "workbench-$Version-windows-evidence"
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$transcriptPath = Join-Path $evidenceDir 'validation.log'
$installerPath = Join-Path $env:RUNNER_TEMP $assetName
$sidecarPath = "$installerPath.sha256"
$installDir = Join-Path $env:RUNNER_TEMP "workbench-$Version-isolated-install"
$checks = [System.Collections.Generic.List[object]]::new()
$details = [ordered]@{}
$failure = $null

function Add-Check([string]$name, [string]$status, [string]$detail) {
  $script:checks.Add([ordered]@{ name = $name; status = $status; detail = $detail })
  Write-Host "[$status] $name — $detail"
}

function Save-IconPreview([string]$source, [string]$output) {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
  if ($null -eq $icon) { throw "No associated icon could be extracted from $source" }
  try {
    $bitmap = $icon.ToBitmap()
    try { $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $bitmap.Dispose() }
  }
  finally { $icon.Dispose() }
}

function Test-IconPixelsEqual([string]$leftPath, [string]$rightPath) {
  $left = [System.Drawing.Bitmap]::new($leftPath)
  $right = [System.Drawing.Bitmap]::new($rightPath)
  try {
    if ($left.Width -ne $right.Width -or $left.Height -ne $right.Height) { return $false }
    for ($y = 0; $y -lt $left.Height; $y++) {
      for ($x = 0; $x -lt $left.Width; $x++) {
        if ($left.GetPixel($x, $y).ToArgb() -ne $right.GetPixel($x, $y).ToArgb()) { return $false }
      }
    }
    return $true
  }
  finally {
    $left.Dispose()
    $right.Dispose()
  }
}

Start-Transcript -Path $transcriptPath -Force | Out-Null
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type @'
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;
public static class WorkbenchIconResources {
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private const int RT_GROUP_ICON = 14;
    private delegate bool EnumResourceNameProc(System.IntPtr module, System.IntPtr type, System.IntPtr name, System.IntPtr parameter);
    [DllImport("shell32.dll", EntryPoint = "ExtractIconExW", CharSet = CharSet.Unicode)]
    private static extern uint ExtractIconEx(string file, int index, System.IntPtr[] large, System.IntPtr[] small, uint count);
    [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern System.IntPtr LoadLibraryEx(string file, System.IntPtr fileHandle, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "EnumResourceNamesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNames(System.IntPtr module, System.IntPtr type, EnumResourceNameProc callback, System.IntPtr parameter);
    [DllImport("kernel32.dll", EntryPoint = "FreeLibrary", SetLastError = true)]
    private static extern bool FreeLibrary(System.IntPtr module);
    public static uint Count(string file) => ExtractIconEx(file, -1, null, null, 0);
    public static string[] GroupIconResourceIds(string file) {
        var module = LoadLibraryEx(file, System.IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == System.IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var ids = new List<string>();
        EnumResourceNameProc callback = (handle, type, name, parameter) => {
            var value = name.ToInt64();
            ids.Add((value & ~0xffffL) == 0 ? "#" + (value & 0xffffL).ToString() : Marshal.PtrToStringUni(name));
            return true;
        };
        try {
            if (!EnumResourceNames(module, new System.IntPtr(RT_GROUP_ICON), callback, System.IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return ids.ToArray();
        } finally { FreeLibrary(module); }
    }
}
'@

  $setupUrl = "$releaseBase/$assetName"
  $sidecarUrl = "$releaseBase/$assetName.sha256"
  Invoke-WebRequest -Uri $setupUrl -OutFile $installerPath -MaximumRedirection 10
  Invoke-WebRequest -Uri $sidecarUrl -OutFile $sidecarPath -MaximumRedirection 10

  $actualSize = (Get-Item -LiteralPath $installerPath).Length
  if ($actualSize -ne $ExpectedSize) {
    throw "Published installer byte count mismatch: expected $ExpectedSize, got $actualSize."
  }
  $sidecar = [System.IO.File]::ReadAllText($sidecarPath).Trim()
  if ($sidecar -notmatch "^$ExpectedSha256\s+$([regex]::Escape($assetName))$") {
    throw 'Published SHA-256 sidecar does not match the supplied frozen release asset metadata.'
  }
  $actualSidecarSize = (Get-Item -LiteralPath $sidecarPath).Length
  $actualSidecarSha256 = (Get-FileHash -LiteralPath $sidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSidecarSize -ne $ExpectedSidecarSize -or $actualSidecarSha256 -ne $ExpectedSidecarSha256) {
    throw "Published sidecar metadata mismatch: bytes=$actualSidecarSize sha256=$actualSidecarSha256."
  }
  $actualSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $ExpectedSha256) {
    throw "Published installer SHA-256 mismatch: expected $ExpectedSha256, got $actualSha256."
  }
  $details.asset = [ordered]@{
    tag = $Tag
    url = $setupUrl
    bytes = $actualSize
    sha256 = $actualSha256
    sidecar_bytes = $actualSidecarSize
    sidecar_sha256 = $actualSidecarSha256
    sidecar = $sidecar
  }
  Add-Check 'published asset bytes and SHA-256' 'PASS' "$actualSize-byte installer and $actualSidecarSize-byte sidecar match their frozen digests."

  $installerInfo = (Get-Item -LiteralPath $installerPath).VersionInfo
  if ($installerInfo.ProductName -ne 'AI Course Workbench' -or $installerInfo.ProductVersion -ne $Version) {
    throw "Installer product metadata mismatch: ProductName='$($installerInfo.ProductName)' ProductVersion='$($installerInfo.ProductVersion)'."
  }
  if ($installerInfo.FileVersion -notmatch $versionPattern) {
    throw "Installer FileVersion mismatch: '$($installerInfo.FileVersion)'."
  }
  $details.installer_version = [ordered]@{
    product_name = $installerInfo.ProductName
    product_version = $installerInfo.ProductVersion
    file_version = $installerInfo.FileVersion
  }
  Add-Check 'installer version resource' 'PASS' "ProductVersion=$($installerInfo.ProductVersion); FileVersion=$($installerInfo.FileVersion)."

  $installerIconCount = [WorkbenchIconResources]::Count($installerPath)
  if ($installerIconCount -lt 1) { throw 'The published NSIS installer contains no extractable icon resource.' }
  $installerIconResourceIds = @([WorkbenchIconResources]::GroupIconResourceIds($installerPath))
  if ($installerIconResourceIds.Count -lt 1) { throw 'The published NSIS installer has no RT_GROUP_ICON resources.' }
  Save-IconPreview $installerPath (Join-Path $evidenceDir 'installer-icon-preview.png')
  $details.installer_icon_resource_ids = $installerIconResourceIds
  Add-Check 'installer icon resource' 'PASS' "$installerIconCount group(s), RT_GROUP_ICON resource ID(s) $($installerIconResourceIds -join ', '); default Shell-associated preview saved."

  if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
  $installArgs = @('/S', "/D=$installDir")
  $process = Start-Process -FilePath $installerPath -ArgumentList $installArgs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Isolated silent install exited with code $($process.ExitCode)." }
  Add-Check 'isolated NSIS install' 'PASS' "Installed into runner temp directory $installDir."

  $appCandidates = @(
    Get-ChildItem -LiteralPath $installDir -Filter '*.exe' -File -Recurse |
      Where-Object {
        $_.Name -notmatch '^(unins|setup)' -and
        $_.VersionInfo.ProductName -eq 'AI Course Workbench' -and
        $_.VersionInfo.ProductVersion -eq $Version
      }
  )
  if ($appCandidates.Count -ne 1) {
    $found = @(Get-ChildItem -LiteralPath $installDir -Filter '*.exe' -File -Recurse | ForEach-Object {
      "$($_.FullName) [$($_.VersionInfo.ProductName); $($_.VersionInfo.ProductVersion); $($_.VersionInfo.FileVersion)]"
    }) -join '; '
    throw "Expected exactly one installed Workbench executable at version $Version; found $($appCandidates.Count). $found"
  }
  $appPath = $appCandidates[0].FullName
  $appInfo = $appCandidates[0].VersionInfo
  if ($appInfo.FileVersion -notmatch $versionPattern) {
    throw "Installed application FileVersion mismatch: '$($appInfo.FileVersion)'."
  }
  $appIconCount = [WorkbenchIconResources]::Count($appPath)
  if ($appIconCount -lt 1) { throw 'The installed application contains no extractable icon resource.' }
  $appIconResourceIds = @([WorkbenchIconResources]::GroupIconResourceIds($appPath))
  if ($appIconResourceIds.Count -lt 1) { throw 'The installed application has no RT_GROUP_ICON resources.' }
  Save-IconPreview $appPath (Join-Path $evidenceDir 'application-icon-preview.png')
  $details.application = [ordered]@{
    path = $appPath
    product_name = $appInfo.ProductName
    product_version = $appInfo.ProductVersion
    file_version = $appInfo.FileVersion
    icon_groups = $appIconCount
    icon_resource_ids = $appIconResourceIds
  }
  Add-Check 'installed application version and icon' 'PASS' "ProductVersion=$($appInfo.ProductVersion); FileVersion=$($appInfo.FileVersion); $appIconCount icon group(s)."

  $uninstallerCandidates = @(
    Get-ChildItem -LiteralPath $installDir -Filter '*.exe' -File -Recurse |
      Where-Object { $_.Name -match '^(unins.*|uninstall)\.exe$' }
  )
  if ($uninstallerCandidates.Count -ne 1) {
    throw "Expected one installed NSIS uninstaller; found $($uninstallerCandidates.Count)."
  }
  $uninstallerPath = $uninstallerCandidates[0].FullName
  $uninstallerIconCount = [WorkbenchIconResources]::Count($uninstallerPath)
  if ($uninstallerIconCount -lt 1) { throw 'The installed NSIS uninstaller contains no extractable icon resource.' }
  $uninstallerIconResourceIds = @([WorkbenchIconResources]::GroupIconResourceIds($uninstallerPath))
  if ($uninstallerIconResourceIds.Count -lt 1) { throw 'The installed NSIS uninstaller has no RT_GROUP_ICON resources.' }
  $uninstallerPreview = Join-Path $evidenceDir 'uninstaller-icon-preview.png'
  Save-IconPreview $uninstallerPath $uninstallerPreview
  $appPreview = Join-Path $evidenceDir 'application-icon-preview.png'
  $installerPreview = Join-Path $evidenceDir 'installer-icon-preview.png'
  $details.uninstaller = [ordered]@{
    path = $uninstallerPath
    icon_groups = $uninstallerIconCount
    icon_resource_ids = $uninstallerIconResourceIds
  }
  Add-Check 'installed uninstaller icon resource' 'PASS' "$uninstallerIconCount group(s), RT_GROUP_ICON resource ID(s) $($uninstallerIconResourceIds -join ', '); PNG preview saved."

  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  if (-not (Test-Path -LiteralPath $startMenu)) { throw 'The per-user Start Menu Programs directory was not created.' }
  $shell = New-Object -ComObject WScript.Shell
  $shortcutMatches = @(
    Get-ChildItem -LiteralPath $startMenu -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object {
        $shortcut = $shell.CreateShortcut($_.FullName)
        $target = [Environment]::ExpandEnvironmentVariables($shortcut.TargetPath).Trim('"')
        $target -and [string]::Equals(
          [System.IO.Path]::GetFullPath($target),
          [System.IO.Path]::GetFullPath($appPath),
          [System.StringComparison]::OrdinalIgnoreCase
        )
      }
  )
  if ($shortcutMatches.Count -ne 1) {
    throw "Expected one Start Menu shortcut targeting the installed app; found $($shortcutMatches.Count)."
  }
  $shortcutPath = $shortcutMatches[0].FullName
  $startLink = $shell.CreateShortcut($shortcutPath)
  $rawIconLocation = [string]$startLink.IconLocation
  $iconSpec = [Environment]::ExpandEnvironmentVariables($rawIconLocation).Trim().Trim('"')
  $iconIndex = 0
  $iconPath = $iconSpec
  if ($iconSpec -match '^(.*?),\s*(-?\d+)$') {
    $iconPath = $Matches[1].Trim().Trim('"')
    $iconIndex = [int]$Matches[2]
  }
  $iconFallback = 'explicit path'
  if ([string]::IsNullOrWhiteSpace($iconPath)) {
    # Windows Shell uses the shortcut target's associated icon when IconLocation has no path.
    $iconPath = [Environment]::ExpandEnvironmentVariables([string]$startLink.TargetPath).Trim().Trim('"')
    $iconIndex = 0
    $iconFallback = 'target default icon (empty IconLocation path)'
  }
  if (-not [System.IO.Path]::IsPathRooted($iconPath)) { $iconPath = Join-Path $installDir $iconPath }
  $shortcutDetails = [ordered]@{
    shortcut = $shortcutPath
    target = $startLink.TargetPath
    icon_location_raw = $rawIconLocation
    icon_spec_expanded = $iconSpec
    icon_index = $iconIndex
    icon_resolution = $iconFallback
    resolved_icon_path = $iconPath
  }
  $details.start_menu_shortcut = $shortcutDetails
  if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "The Start Menu shortcut icon target is missing: $iconPath"
  }
  $shortcutIconCount = [WorkbenchIconResources]::Count($iconPath)
  if ($shortcutIconCount -lt 1) { throw "The Start Menu shortcut's icon target has no icon resource: $iconPath" }
  $shortcutIconResourceIds = @([WorkbenchIconResources]::GroupIconResourceIds($iconPath))
  if ($shortcutIconResourceIds.Count -lt 1) { throw "The Start Menu shortcut icon target has no RT_GROUP_ICON resources: $iconPath" }
  Save-IconPreview $iconPath (Join-Path $evidenceDir 'start-menu-icon-preview.png')
  $shortcutDetails.icon_groups = $shortcutIconCount
  $shortcutDetails.icon_resource_ids = $shortcutIconResourceIds
  Add-Check 'Start Menu shortcut target and icon resource' 'PASS' "Target=$($startLink.TargetPath); IconLocation='$rawIconLocation' (index $iconIndex; $iconFallback); resolved icon=$iconPath; resource ID(s) $($shortcutIconResourceIds -join ', ')."

  $startMenuPreview = Join-Path $evidenceDir 'start-menu-icon-preview.png'
  $startMenuMatchesApp = Test-IconPixelsEqual $startMenuPreview $appPreview
  if (-not $startMenuMatchesApp) { throw 'The Start Menu default-target icon preview does not match the installed application icon pixels.' }
  $installerMatchesApp = Test-IconPixelsEqual $installerPreview $appPreview
  $uninstallerMatchesApp = Test-IconPixelsEqual $uninstallerPreview $appPreview
  $details.icon_pixel_comparison = [ordered]@{
    installer_matches_application = $installerMatchesApp
    uninstaller_matches_application = $uninstallerMatchesApp
    start_menu_matches_application = $startMenuMatchesApp
    method = 'System.Drawing.ExtractAssociatedIcon previews saved as PNG, then per-pixel ARGB equality at native extracted dimensions.'
  }
  if ($RequireIconParity -and (-not $installerMatchesApp -or -not $uninstallerMatchesApp)) {
    throw 'Installer, application, and uninstaller icon previews are not pixel-identical.'
  }
  Add-Check 'installer, application, uninstaller, and Start Menu icon pixel comparison' $(if ($installerMatchesApp -and $uninstallerMatchesApp -and $startMenuMatchesApp) { 'PASS' } else { 'MISMATCH' }) "Installer matches app=$installerMatchesApp; uninstaller matches app=$uninstallerMatchesApp; Start Menu matches app=$startMenuMatchesApp."

  Add-Check 'interactive Windows shell appearance' 'NOT_TESTED' 'Hosted Actions runner is not treated as a user desktop; no Explorer, Start Menu, or taskbar screenshot is claimed.'
}
catch {
  $failure = $_.Exception.Message
  Add-Check 'validation' 'FAIL' $failure
  throw
}
finally {
  $result = [ordered]@{
    release_tag = $Tag
    expected_asset_sha256 = $ExpectedSha256
    expected_sidecar_sha256 = $ExpectedSidecarSha256
    status = if ($failure) { 'failed' } else { 'passed' }
    checks = @($checks)
    details = $details
    failure = $failure
    limitation = 'This hosted-runner verification does not prove the rendered Explorer, Start Menu, window, or taskbar appearance on a real Windows desktop.'
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $evidenceDir 'result.json'),
    ($result | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
  )
  if ($env:GITHUB_STEP_SUMMARY) {
    @"
## Published Windows installer metadata check

- Result: **$($result.status)**
- Published bytes/SHA-256, installer/app/uninstaller versions and icon resources, NSIS temp install, icon pixel parity, and Start Menu shortcut target/icon: checked by the PowerShell log and `result.json`.
- `*.png` files are previews extracted from PE icon resources, **not** screenshots of the Windows shell. A real Explorer/Start/taskbar visual check still requires an interactive Windows desktop.
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
  }
  Stop-Transcript | Out-Null
}
