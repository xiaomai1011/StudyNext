$ErrorActionPreference = 'Stop'

$logPath = Join-Path $PSScriptRoot 'poc-events.log'
$now = Get-Date
$record = [ordered]@{
  firedAtLocal = $now.ToString('o')
  firedAtUtc = $now.ToUniversalTime().ToString('o')
  userName = $env:USERNAME
  computerName = $env:COMPUTERNAME
  source = 'StudyNext-NotificationPoC'
}
$line = ($record | ConvertTo-Json -Compress)
Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
