param(
    [string]$SourcePath = (Join-Path (Split-Path $PSScriptRoot -Parent) '../ygopro'),
    [ValidateRange(15, 250)][int]$MaxExtra = 30,
    [ValidateRange(15, 250)][int]$MaxSide = 30
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$branch = & git -C $source branch --show-current
if ($LASTEXITCODE -or $branch -ne 'cube-server') { throw 'Build the Cube client from cube-server.' }
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
$vs = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual Studio C++ tools are required.' }
$oldPath = $env:PATH
Push-Location $source
try {
    $env:PATH = (Join-Path $source 'nasm') + ';' + $env:PATH
    & ./premake5.exe vs2022 --client --no-dxsdk --use-simd=sse2 --build-opus-vorbis "--max-extra=$MaxExtra" "--max-side=$MaxSide"
    if ($LASTEXITCODE) { throw 'Premake failed.' }
    [xml]$project = Get-Content -Raw build/YGOPro.vcxproj
    $release = $project.Project.ItemDefinitionGroup | Where-Object { $_.Condition -like '*Release|x64*' }
    $defines = [string]$release.ClCompile.PreprocessorDefinitions
    foreach ($define in @("YGOPRO_MAX_EXTRA=$MaxExtra", "YGOPRO_MAX_SIDE=$MaxSide", 'YGOPRO_USE_AUDIO', 'YGOPRO_MINIAUDIO_SUPPORT_OPUS_VORBIS')) {
        if ($define -notin $defines.Split(';')) { throw "Missing release definition: $define" }
    }
    & "$vs/MSBuild/Current/Bin/MSBuild.exe" build/YGOPro.sln /m /p:Configuration=Release /p:Platform=x64 /verbosity:minimal
    if ($LASTEXITCODE) { throw 'MSBuild failed.' }
    $exe = Get-Item bin/release/x64/YGOPro.exe
    if ($exe.VersionInfo.FileVersion -notlike '*cube*') { throw 'Cube version suffix missing.' }
    [pscustomobject]@{ File = $exe.FullName; Version = $exe.VersionInfo.FileVersion; MaxExtra = $MaxExtra; MaxSide = $MaxSide; SHA256 = (Get-FileHash $exe.FullName).Hash }
} finally {
    Pop-Location
    $env:PATH = $oldPath
}
