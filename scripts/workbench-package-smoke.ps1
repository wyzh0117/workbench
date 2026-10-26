# Validate the staged Windows installer and installed native process, not its UI.
[CmdletBinding()]
param(
  [string]$Installer = 'dist/AI-Course-Workbench-Windows-x64-setup.exe',
  [string]$Config = 'src-tauri/tauri.conf.json',
  [string]$EvidenceDirectory = '.qa-output/windows-package'
)

function Assert-WorkbenchVersion {
  param([string]$Actual, [string]$Expected, [string]$Label)
  if ($Actual -ne $Expected) {
    throw "$Label version '$Actual' does not match expected '$Expected'."
  }
}

function Assert-WorkbenchPeX64 {
  param([string]$Path)
  $Stream = [System.IO.File]::OpenRead($Path)
  $Reader = [System.IO.BinaryReader]::new($Stream)
  try {
    if ($Stream.Length -lt 64 -or $Reader.ReadUInt16() -ne 0x5a4d) {
      throw 'Installed app is not a valid PE executable.'
    }
    $Stream.Position = 0x3c
    $Offset = $Reader.ReadInt32()
    if ($Offset -lt 64 -or $Offset -gt 1048576 -or $Offset -gt ($Stream.Length - 6)) {
      throw 'Installed app has an invalid PE header offset.'
    }
    $Stream.Position = $Offset
    if ($Reader.ReadUInt32() -ne 0x00004550) {
      throw 'Installed app has an invalid PE signature.'
    }
    if ($Reader.ReadUInt16() -ne 0x8664) {
      throw 'Installed app is not an x64 PE executable.'
    }
  } finally {
    $Reader.Dispose()
    $Stream.Dispose()
  }
}

function Resolve-WorkbenchShortcutIcon {
  param([AllowEmptyString()][string]$IconLocation, [string]$TargetPath)
  # Strip the final resource index FIRST: ',0' means use the target's icon.
  $Path = ($IconLocation -replace ',\s*-?\d+\s*$', '').Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($Path)) { $Path = $TargetPath.Trim().Trim('"') }
  return [Environment]::ExpandEnvironmentVariables($Path)
}

function Invoke-WorkbenchPackageSmoke {
  param([string]$InstallerPath, [string]$ConfigPath, [string]$EvidencePath)
  $ErrorActionPreference = 'Stop'
  if (-not $IsWindows) { throw 'Windows package validation requires a Windows runner.' }
  $InstallerFile = Get-Item -LiteralPath $InstallerPath
  $Configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $Expected = [string]$Configuration.version
  $Product = [string]$Configuration.productName
  New-Item -ItemType Directory -Path $EvidencePath -Force | Out-Null
  $Evidence = (Get-Item -LiteralPath $EvidencePath).FullName

  $Sidecar = (Get-Content -LiteralPath ($InstallerFile.FullName + '.sha256') -Raw).Trim()
  if ($Sidecar -notmatch '^([a-fA-F0-9]{64})\s+\*?(.+)$' -or $Matches[2] -ne $InstallerFile.Name) {
    throw 'Invalid Windows installer checksum sidecar.'
  }
  $ExpectedHash = $Matches[1].ToLowerInvariant()
  $ActualHash = (Get-FileHash -LiteralPath $InstallerFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) { throw 'Windows installer checksum does not match staged bytes.' }
  Assert-WorkbenchVersion $InstallerFile.VersionInfo.ProductVersion $Expected 'Installer'

  $TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
  $InstallDirectory = Join-Path $TempRoot ('workbench-package-' + [guid]::NewGuid().ToString('N'))
  # NSIS requires /D to be LAST and its path to be unquoted, even with spaces.
  $Setup = Start-Process -FilePath $InstallerFile.FullName -ArgumentList "/S /D=$InstallDirectory" -PassThru
  try {
    if (-not $Setup.WaitForExit(180000)) {
      Stop-Process -Id $Setup.Id -Force -ErrorAction SilentlyContinue
      throw 'Silent Windows installation exceeded 180 seconds.'
    }
    if ($Setup.ExitCode -ne 0) { throw "Silent installation failed with exit code $($Setup.ExitCode)." }
  } finally { $Setup.Dispose() }

  $Executable = Join-Path $InstallDirectory 'ai-course-workbench.exe'
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Installer did not create the expected executable at $Executable."
  }
  $InstalledFile = Get-Item -LiteralPath $Executable
  Assert-WorkbenchVersion $InstalledFile.VersionInfo.ProductVersion $Expected 'Installed application'
  Assert-WorkbenchPeX64 $Executable

  $ShortcutRoots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
  $ShortcutFiles = @($ShortcutRoots | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter "$Product.lnk" -File -Recurse
  })
  $ShortcutReports = @()
  $Shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($Link in $ShortcutFiles) {
      $Shortcut = $Shell.CreateShortcut($Link.FullName)
      try {
        $Target = [Environment]::ExpandEnvironmentVariables([string]$Shortcut.TargetPath)
        $RawIcon = [string]$Shortcut.IconLocation
        Write-Host "Shortcut=$($Link.FullName) TargetPath='$Target' IconLocation='$RawIcon'"
        # Ignore unrelated older installations; require a shortcut for THIS one.
        if ([System.IO.Path]::GetFullPath($Target) -ine [System.IO.Path]::GetFullPath($Executable)) { continue }
        $IconPath = Resolve-WorkbenchShortcutIcon $RawIcon $Target
        if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) { throw "Shortcut icon target is missing: '$IconPath'." }
        $ShortcutReports += @{ path = $Link.FullName; target = $Target; raw_icon_location = $RawIcon; resolved_icon_path = $IconPath }
      } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shortcut) }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shell) }
  if ($ShortcutReports.Count -eq 0) { throw 'No Start Menu shortcut targets the installed application.' }

  # Verify a nonempty associated icon resource, not its visual branding/appearance.
  Add-Type -AssemblyName System.Drawing
  $Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Executable)
  if ($null -eq $Icon -or $Icon.Width -le 0 -or $Icon.Height -le 0) { throw 'Installed executable has no associated icon.' }
  try {
    $IconStream = [IO.File]::Create((Join-Path $Evidence 'installed-app-icon.ico'))
    try { $Icon.Save($IconStream) } finally { $IconStream.Dispose() }
  } finally { $Icon.Dispose() }

  $App = Start-Process -FilePath $Executable -WorkingDirectory $InstallDirectory -PassThru `
    -RedirectStandardOutput (Join-Path $Evidence 'native-stdout.log') `
    -RedirectStandardError (Join-Path $Evidence 'native-stderr.log')
  try {
    if ($App.WaitForExit(10000)) { throw "Installed app exited during the 10-second startup observation (exit $($App.ExitCode))." }
    $App.Refresh()
    if ($App.HasExited) { throw 'Installed app exited before startup verification finished.' }
    $Report = [ordered]@{
      package = $InstallerFile.Name
      version = $Expected
      sha256 = $ActualHash
      architecture = 'x64'
      installer_exit_code = 0
      installed_executable = $Executable
      shortcuts = $ShortcutReports
      icon_resource_verified = $true
      native_process_alive_seconds = 10
      process_id = $App.Id
      visual_ui_verified = $false
      start_menu_appearance_verified = $false
    }
    $Report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence 'windows-package.json') -Encoding utf8
  } finally {
    $App.Refresh()
    if (-not $App.HasExited) { Stop-Process -Id $App.Id -Force -ErrorAction SilentlyContinue }
    $App.Dispose()
  }
  Write-Host 'Windows checksum, silent install, version, x64 binary, shortcut/icon resource and 10-second native process verified; visual UI/Start Menu appearance were not tested.'
}

# Dot-sourcing exposes validation helpers without performing an installation.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-WorkbenchPackageSmoke -InstallerPath $Installer -ConfigPath $Config -EvidencePath $EvidenceDirectory
}
