$ErrorActionPreference = "Stop"
if ($env:RUNNER_OS -ne "Windows" -and $env:OS -ne "Windows_NT") {
  throw "Windows filesystem validation must run on Windows"
}
$unicode = [char]0x03A9
$root = Join-Path ([System.IO.Path]::GetTempPath()) "Pawsh locked Unicode $unicode"
New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  $longPathsEnabled = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled).LongPathsEnabled
  $segment = "nested-directory-1234567890"
  $longDirectory = $root
  $targetLength = if ($longPathsEnabled -eq 1) { 300 } else { 210 }
  while ($longDirectory.Length -lt $targetLength) { $longDirectory = Join-Path $longDirectory $segment }
  New-Item -ItemType Directory -Force -Path $longDirectory | Out-Null
  $longFile = Join-Path $longDirectory "evidence-$unicode.txt"
  [System.IO.File]::WriteAllText($longFile, "portable", [System.Text.Encoding]::UTF8)
  if ([System.IO.File]::ReadAllText($longFile) -ne "portable") { throw "Long Unicode path round trip failed" }

  $locked = Join-Path $root "locked.txt"
  [System.IO.File]::WriteAllText($locked, "locked")
  $handle = [System.IO.File]::Open($locked, "Open", "ReadWrite", "None")
  try {
    node --eval "require('node:fs').rmSync(process.argv[1])" $locked 2>$null
    if ($LASTEXITCODE -eq 0) { throw "Exclusive Windows lock unexpectedly allowed deletion" }
  } finally {
    $handle.Dispose()
  }
  node --eval "require('node:fs').rmSync(process.argv[1])" $locked
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $locked)) { throw "Cleanup after releasing Windows lock failed" }
  [ordered]@{ longPathsEnabled = $longPathsEnabled; testedPathLength = $longFile.Length; lockedFileCleanup = "passed" } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $root "windows-filesystem.json")
  New-Item -ItemType Directory -Force -Path artifacts | Out-Null
  Copy-Item (Join-Path $root "windows-filesystem.json") artifacts/windows-filesystem.json
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
