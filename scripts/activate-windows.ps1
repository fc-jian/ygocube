# Add only project-local Windows tools to this PowerShell session.
$root = Split-Path $PSScriptRoot -Parent
$paths = @('envs/windows/tools/node_modules/.bin', 'envs/windows/python/Scripts', 'envs/windows/vips/vips-dev-8.18/bin') | ForEach-Object { Join-Path $root $_ }
$env:PATH = ($paths -join ';') + ';' + $env:PATH
