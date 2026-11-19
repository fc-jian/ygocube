param([ValidateSet('Start','Stop','Status')][string]$Action = 'Start', [switch]$Duel, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$profileName = if ($Duel) { 'duel' } else { 'cube' }
$runtime = Join-Path $root "data/local-dev/$profileName"
$recordFile = Join-Path $runtime 'launcher.json'
New-Item -ItemType Directory -Force $runtime | Out-Null
$running = $null
if (Test-Path $recordFile) {
    $record = Get-Content $recordFile -Raw | ConvertFrom-Json
    $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.started).ToUniversalTime().Ticks) { $running = $candidate }
}
if (!$running -and (Test-Path (Join-Path $runtime 'processes.json'))) {
    $previous = Get-Content (Join-Path $runtime 'processes.json') -Raw | ConvertFrom-Json
    $native = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.supervisor)" -ErrorAction SilentlyContinue
    $expected = Join-Path $PSScriptRoot 'dev-local.cjs'
    if ($native -and $native.CommandLine.Contains($expected) -and ($native.CommandLine.Contains('--duel') -eq [bool]$Duel)) {
        $running = Get-Process -Id $previous.supervisor -ErrorAction SilentlyContinue
    }
}
if ($Action -eq 'Status') { if ($running) { "Running $profileName PID $($running.Id)" } else { "Stopped $profileName" }; return }
if ($Action -eq 'Stop') {
    if ($running) { & taskkill.exe /PID $running.Id /T /F; if ($LASTEXITCODE) { throw 'Stop failed' } }
    return
}
if ($running) { "Already running $profileName PID $($running.Id)"; return }
$env:LOCAL_WEB_PORT = if ($Port) { [string]$Port } elseif ($Duel) { '3100' } else { '3200' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = @('"' + (Join-Path $PSScriptRoot 'dev-local.cjs') + '"')
if ($Duel) { $arguments += '--duel' }
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'supervisor.log') -RedirectStandardError (Join-Path $runtime 'supervisor.error.log')
@{pid=$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content $recordFile -Encoding UTF8
$port = [int]$env:LOCAL_WEB_PORT
$route = if ($Duel) { '/duel' } else { '/' }
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "Startup failed. Read $runtime/supervisor.error.log and service logs." }
    try {
        $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port$route" -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and (Select-String -Path (Join-Path $runtime 'supervisor.log') -Pattern '^Ready:' -Quiet)) { "Ready: http://127.0.0.1:$port$route"; return }
    } catch {}
    Start-Sleep -Milliseconds 500
}
throw "Startup timed out; inspect $runtime before retrying."
