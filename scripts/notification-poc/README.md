# StudyNext Windows Notification PoC

This folder is an independent feasibility harness for StudyNext v0.4.0. It does not import the application or modify its reminder scheduler.

## Commands

```powershell
# Inspect environment and whether the PoC task exists
powershell -NoProfile -ExecutionPolicy Bypass -File .\poc.ps1 -Action status

# Probe the WinRT toast API
powershell -NoProfile -ExecutionPolicy Bypass -File .\poc.ps1 -Action probe-toast

# Add one scheduled toast to the notification queue, verify it, then remove it
powershell -NoProfile -ExecutionPolicy Bypass -File .\poc.ps1 -Action scheduled-toast

# Register a per-user Task Scheduler task, run it, verify the worker event, then remove it
powershell -NoProfile -ExecutionPolicy Bypass -File .\poc.ps1 -Action all -DelayMinutes 1
```

`-Action all` removes both the task and `poc-events.log` when it finishes. To inspect the task separately:

```powershell
.\poc.ps1 -Action register -DelayMinutes 5
.\poc.ps1 -Action run
.\poc.ps1 -Action status
.\poc.ps1 -Action remove
```

## What this proves

- A per-user Task Scheduler task can be registered, started, observed and removed without elevation.
- A worker process can write a timestamped event when launched by Task Scheduler.
- The Windows Runtime `ScheduledToastNotification` API can add and remove a scheduled toast.

## What this does not prove

- That a toast is visually shown under Focus Assist or notification settings.
- Sleep/resume, clock changes, timezone travel and upgrade/uninstall cleanup.
- Integration with the real StudyNext executable; the application does not yet have a `--check-reminders` mode.
