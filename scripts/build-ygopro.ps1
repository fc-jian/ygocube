param([switch]$SkipDownload)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'ygopro'
$cache = Join-Path $root 'envs/windows/downloads'
New-Item -ItemType Directory -Force $cache | Out-Null
function Fetch($Name, $Url, $Hash, $Folder, $Destination) {
    $archive = Join-Path $cache $Name
    if (!(Test-Path $archive)) {
        if ($SkipDownload) { throw "Missing $archive" }
        Invoke-WebRequest -UseBasicParsing $Url -OutFile $archive
    }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $Hash) { throw "Checksum mismatch: $Name" }
    $stage = Join-Path $cache ($Name + '.extracted')
    if (!(Test-Path $stage)) {
        New-Item -ItemType Directory $stage | Out-Null
        tar.exe -xf $archive -C $stage
        if ($LASTEXITCODE) { throw "Extraction failed: $Name" }
    }
    $from = if ($Folder) { Join-Path $stage $Folder } else { $stage }
    New-Item -ItemType Directory -Force $Destination | Out-Null
    Copy-Item -Path "$from/*" -Destination $Destination -Recurse -Force
}
Fetch 'premake.zip' 'https://github.com/premake/premake-core/releases/download/v5.0.0-beta8/premake-5.0.0-beta8-windows.zip' 'e64ce2ed8778e0098f63674cca61fe33941b5f0c8d9a4afd651152bdea3758ab' '' "$root/envs/windows/premake"
Fetch 'event.tar.gz' 'https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz' 'f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c' 'libevent-2.1.13-stable' "$source/event"
Fetch 'sqlite.zip' 'https://www.sqlite.org/2026/sqlite-amalgamation-3530300.zip' '646421e12aac110282ef8cc68f1a62d4bb15fc7b8f09da0b53e29ee690500431' 'sqlite-amalgamation-3530300' "$source/sqlite3"
Fetch 'lzma.tar.gz' 'https://github.com/tukaani-project/xz/releases/download/v5.8.3/xz-5.8.3.tar.gz' '3d3a1b973af218114f4f889bbaa2f4c037deaae0c8e815eec381c3d546b974a0' 'xz-5.8.3' "$source/lzma"
Fetch 'lua.tar.gz' 'https://www.lua.org/ftp/lua-5.4.8.tar.gz' '4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae' 'lua-5.4.8' "$source/lua"
Copy-Item "$source/premake/*" $source -Recurse -Force
Copy-Item "$source/resource/*" $source -Recurse -Force
Copy-Item "$source/premake/event/msvc-event-config.h" "$source/event/include/event2/event-config.h" -Force
Copy-Item "$source/event/WIN32-Code/nmake/evconfig-private.h" "$source/event/include/evconfig-private.h" -Force
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
$vs = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Install Visual Studio 2022 C++ desktop development tools.' }
Push-Location $source
try {
    & "$root/envs/windows/premake/premake5.exe" vs2022 --use-simd=sse2
    if ($LASTEXITCODE) { throw 'Premake failed' }
    & "$vs/MSBuild/Current/Bin/MSBuild.exe" build/YGOPro.sln /m /p:Configuration=Release /p:Platform=x64 /verbosity:minimal
    if ($LASTEXITCODE) { throw 'MSBuild failed' }
    Copy-Item 'bin/release/x64/ygopro.exe' "$root/srvpro/ygopro/ygopro.exe" -Force
} finally { Pop-Location }
