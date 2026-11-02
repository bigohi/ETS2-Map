# Builds plugin\build\ets2map_telemetry.dll (x64) and the test harness with MSVC.
# Needs Visual Studio 2022 Build Tools (C++ workload).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$env:PATH += ";${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer"  # vcvars64 calls vswhere
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Visual Studio C++ build tools not found" }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$out = Join-Path $here 'build'
New-Item -ItemType Directory -Force $out | Out-Null

$script = Join-Path $out 'build.cmd'
@"
@echo off
call "$vcvars" >nul || exit /b 1
cd /d "$out"
cl /nologo /O2 /W4 /EHsc /MT /LD /utf-8 /I"$here\sdk-include" "$here\src\ets2map_telemetry.cpp" /Fe:ets2map_telemetry.dll /link /DEF:"$here\src\ets2map_telemetry.def" ws2_32.lib || exit /b 1
cl /nologo /O2 /W3 /EHsc /MT /utf-8 /I"$here\sdk-include" "$here\test\harness.cpp" /Fe:harness.exe /link ws2_32.lib || exit /b 1
"@ | Set-Content -Encoding ascii $script
cmd /c $script
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
Get-ChildItem $out -Filter *.dll | Select-Object Name, Length
