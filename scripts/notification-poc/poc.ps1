[CmdletBinding()]
param(
  [ValidateSet('status', 'register', 'run', 'remove', 'probe-toast', 'scheduled-toast', 'all')]
  [string]$Action = 'status',
  [ValidateRange(1, 60)]
  [int]$DelayMinutes = 2,
  [string]$TaskName = 'StudyNext-NotificationPoC'
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
$workerPath = Join-Path $scriptRoot 'worker.ps1'
$logPath = Join-Path $scriptRoot 'poc-events.log'
$description = 'StudyNext independent notification feasibility PoC. Safe to delete.'

function Get-PocTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Register-PocTask {
  $existing = Get-PocTask
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$workerPath`""
  $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $scriptRoot
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($DelayMinutes))
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $description `
    -Force | Out-Null
}

function Run-PocTask {
  if (-not (Get-PocTask)) {
    Register-PocTask
  }
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $state = (Get-PocTask).State
  } while ((Get-Date) -lt $deadline -and ($state -eq 'Running' -or $info.LastTaskResult -eq 267009))
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  if ($info.LastTaskResult -ne 0) {
    throw "Scheduled task finished with result $($info.LastTaskResult)"
  }
}

function Remove-PocTask {
  if (Get-PocTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  if (Test-Path -LiteralPath $logPath) {
    Remove-Item -LiteralPath $logPath -Force
  }
}

function Get-Status {
  $task = Get-PocTask
  $info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
  $events = @()
  if (Test-Path -LiteralPath $logPath) {
    foreach ($line in Get-Content -LiteralPath $logPath -Encoding utf8) {
      try {
        $events += ($line | ConvertFrom-Json)
      } catch {
        $events += $line
      }
    }
  }

  [ordered]@{
    taskName = $TaskName
    exists = [bool]$task
    state = if ($task) { [string]$task.State } else { $null }
    lastRunTime = if ($info) { $info.LastRunTime.ToString('o') } else { $null }
    lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    nextRunTime = if ($info) { $info.NextRunTime.ToString('o') } else { $null }
    logPath = $logPath
    eventCount = $events.Count
    events = $events
    os = [System.Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
  } | ConvertTo-Json -Depth 6 -Compress
}

function Probe-ScheduledToast {
  $result = [ordered]@{
    aumid = 'StudyNext.PoC'
    winRtTypeAvailable = $false
    notifierCreated = $false
    scheduleApiAvailable = $false
    scheduledCount = $null
    error = $null
  }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $type = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $result.winRtTypeAvailable = $null -ne $type
    $null = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('StudyNext.PoC')
    $result.notifierCreated = $true
  } catch {
    $result.error = $_.Exception.Message
  }
  $result | ConvertTo-Json -Compress
}

function Test-ScheduledToast {
  $result = [ordered]@{
    aumid = 'StudyNext.PoC'
    scheduled = $false
    scheduledCount = $null
    deliveryTime = $null
    removed = $false
    error = $null
  }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $null = [Windows.UI.Notifications.ScheduledToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $xmlText = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>StudyNext PoC</text>
      <text>Independent scheduled toast test. This entry is removed by the PoC.</text>
    </binding>
  </visual>
</toast>
"@
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $delivery = [DateTimeOffset]::Now.AddSeconds(15)
    $toast = [Windows.UI.Notifications.ScheduledToastNotification]::new($xml, $delivery)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('StudyNext.PoC')
    $notifier.AddToSchedule($toast)
    $result.scheduleApiAvailable = $true
    $result.scheduled = $true
    $result.deliveryTime = $delivery.ToString('o')
    $remaining = @($notifier.GetScheduledToastNotifications())
    $result.scheduledCount = $remaining.Count
    $notifier.RemoveFromSchedule($toast)
    $result.removed = $true
  } catch {
    $result.error = $_.Exception.Message
  }
  $result | ConvertTo-Json -Compress
}

switch ($Action) {
  'status' { Get-Status }
  'register' { Register-PocTask; Get-Status }
  'run' { Run-PocTask; Get-Status }
  'remove' { Remove-PocTask; Get-Status }
  'probe-toast' { Probe-ScheduledToast }
  'scheduled-toast' { Test-ScheduledToast }
  'all' {
    $toast = Probe-ScheduledToast | ConvertFrom-Json
    $scheduledToast = Test-ScheduledToast | ConvertFrom-Json
    Register-PocTask
    Run-PocTask
    $status = Get-Status | ConvertFrom-Json
    Remove-PocTask
    [ordered]@{
      toast = $toast
      scheduledToast = $scheduledToast
      taskScheduler = $status
      cleanedUp = -not (Get-PocTask)
    } | ConvertTo-Json -Depth 6 -Compress
  }
}
