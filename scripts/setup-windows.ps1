param([string]$Python = 'python', [switch]$SkipHost)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    & git.exe submodule update --init --recursive
    if ($LASTEXITCODE) { throw 'Submodule initialization failed' }
    & npm.cmd install --prefix envs/windows/tools --no-audit --no-fund pnpm@11.20.0
    if ($LASTEXITCODE) { throw 'pnpm installation failed' }
    $pnpm = Join-Path $root 'envs/windows/tools/node_modules/.bin/pnpm.cmd'
    & $pnpm --dir cube install --frozen-lockfile
    if ($LASTEXITCODE) { throw 'Workspace installation failed' }
    & npm.cmd --prefix srvpro ci --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'srvpro installation failed' }
    & $Python -m venv envs/windows/python
    if ($LASTEXITCODE) { throw 'Python 3 is required. Pass -Python with its full executable path.' }
    & envs/windows/python/Scripts/python.exe -m pip install PyYAML==6.0.3 Pillow==12.3.0
    if ($LASTEXITCODE) { throw 'Python dependencies failed' }
    $archive = Join-Path $root 'envs/windows/vips.zip'
    if (!(Test-Path $archive)) { Invoke-WebRequest -UseBasicParsing 'https://github.com/libvips/build-win64-mxe/releases/download/v8.18.6/vips-dev-x64-web-8.18.6.zip' -OutFile $archive }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne '10086f2ccc8e2a861831facabab75fa1b80b4bd03f0a8447623ec581002aa4b2') { throw 'vips checksum mismatch' }
    New-Item -ItemType Directory -Force envs/windows/vips | Out-Null
    tar.exe -xf $archive -C envs/windows/vips
    if ($LASTEXITCODE) { throw 'vips extraction failed' }
    & $pnpm --dir cube --filter @ygocube/duel-protocol build
    if ($LASTEXITCODE) { throw 'Protocol build failed' }
    & $pnpm --dir cube --filter @ygocube/api build
    if ($LASTEXITCODE) { throw 'API build failed' }
    & npm.cmd --prefix srvpro run build
    if ($LASTEXITCODE) { throw 'srvpro build failed' }
    if (!$SkipHost) { & "$PSScriptRoot/build-ygopro.ps1" }
    Write-Output 'Ready. Configure config.yaml and local card resources, then run scripts/dev-windows.ps1 (add -Duel for standalone duel).'
} finally { Pop-Location }
