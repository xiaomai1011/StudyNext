# Windows DDL 系统级提醒 PoC（v0.4.0）

- 版本：0.4.0 研究基线
- 日期：2026-11-12
- 状态：独立 PoC 已验证“任务计划程序”和“计划 Toast API 注册/移除”；尚未替换产品内 `NotificationScheduler`
- 代码：`scripts/notification-poc/poc.ps1`、`scripts/notification-poc/worker.ps1`
- 相关文档：`docs/WINDOWS_NOTIFICATIONS.md`、`docs/V0.4.0_PLAN.md`

## 1. 当前产品行为

当前 `src/main/notifications/scheduler.ts`：

- `ReminderScheduler` 运行在 Electron 主进程内，30 秒 tick。
- 启动时补发最近 10 分钟内错过的提醒。
- 通过 `notification_deliveries` 的 `taskId + ruleId + dueAt` 去重。
- 应用退出后不会继续计时；UI 明确显示“仅在应用运行中提醒”。
- 已有 `NotificationScheduler` 接口和 `createNotificationScheduler()` 工厂，但还没有系统级实现。

因此，v0.4.0 的 Windows 方案必须解决“应用完全退出后仍能提醒”，且不能假装现有 timer 已经具备该能力。

## 2. 三种候选方案

| 维度                  | A. Windows Scheduled Toast                         | B. Task Scheduler + 应用检查模式                               | C. 后台常驻服务                        |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| 触发者                | Windows 通知平台                                   | Windows 任务计划程序                                           | Windows 服务                           |
| 应用是否必须运行      | 注册后可退出                                       | 触发时启动一个无界面检查进程                                   | 服务常驻                               |
| 安装成本              | 需要 AUMID/开始菜单快捷方式/打包身份；代码签名更稳 | 注册计划任务；需要 app 增加 `--check-reminders` 模式           | 安装服务、服务账户、IPC、升级/卸载复杂 |
| 卸载成本              | 删除快捷方式/清理通知历史                          | 删除任务和可执行文件                                           | 停止/删除服务并清理数据                |
| 权限                  | 普通用户可注册部分通知；AUMID 注册可能需要安装器   | 当前用户任务通常无需管理员；系统级/所有用户需要管理员          | 安装/启动通常需要管理员                |
| 休眠恢复              | 由系统通知计划处理；跨时区/改时间要重新计算        | `StartWhenAvailable` 可补跑；`WakeToRun` 可选但会增加耗电/权限 | 服务需自行处理 resume/power event      |
| 重复通知              | 用 tag/group 或应用数据库去重                      | 用现有 `notification_deliveries` 去重；任务本身不重复执行      | 需自行实现全局锁和幂等                 |
| 维护成本              | 中高：打包身份、快捷方式、签名、系统版本           | 中：一个 PowerShell/任务注册器 + app CLI 模式                  | 高：服务生命周期、UI 通知代理、升级    |
| 适合 StudyNext 的阶段 | 签名/安装器成熟后                                  | v0.4 首个可验证方案                                            | 不建议作为第一步                       |

## 3. PoC 实现

### 3.1 文件

```text
scripts/notification-poc/
  poc.ps1       # status/register/run/remove/probe-toast/scheduled-toast/all
  worker.ps1    # 计划任务实际执行的无界面 worker，只写事件日志
  README.md     # 使用说明
```

PoC 不依赖产品源码、不读取用户数据库，也不发送真实 DDL；它只验证 Windows 机制和安装/卸载边界。

### 3.2 任务计划程序流程

`poc.ps1 -Action all -DelayMinutes 1` 执行：

1. 用 `New-ScheduledTaskAction` 创建 `powershell.exe -File worker.ps1` 动作。
2. 用 `New-ScheduledTaskTrigger -Once` 创建一次性触发器。
3. 使用当前用户、`Interactive` 登录类型、`Limited` 运行级别注册任务。
4. 通过 `Start-ScheduledTask` 立即触发一次，等待 `LastTaskResult`。
5. 读取 `poc-events.log`，确认 worker 实际写入时间、用户和机器名。
6. 删除任务和日志，避免留下系统状态。

### 3.3 计划 Toast 流程

`poc.ps1 -Action scheduled-toast`：

1. 加载 `Windows.UI.Notifications` 与 `Windows.Data.Xml.Dom` WinRT 类型。
2. 创建 `ToastNotificationManager.CreateToastNotifier('StudyNext.PoC')`。
3. 构造 `ScheduledToastNotification`，设置 15 秒后的 `DateTimeOffset`。
4. `AddToSchedule`，读取 `GetScheduledToastNotifications()` 数量。
5. `RemoveFromSchedule`，确认清理成功。

此 PoC 不等待实际弹窗，也不把“注册成功”写成“视觉通知已验证”。

## 4. 本次实测结果

环境：

- Windows：`Microsoft Windows NT 10.0.26200.0`
- PowerShell：`5.1.26100.9711`
- 执行用户：`45181`，机器：`ASUKA`
- 执行时间：2026-11-12 08:35（Asia/Shanghai）

### 4.1 计划 Toast

```json
{
  "aumid": "StudyNext.PoC",
  "scheduled": true,
  "scheduledCount": 1,
  "deliveryTime": "2026-11-12T08:35:58.8196982+08:00",
  "removed": true,
  "error": null,
  "scheduleApiAvailable": true
}
```

结论：当前系统能创建通知器、加入计划队列、查询到 1 条计划通知并移除。实际弹窗是否显示还取决于 AUMID 注册、开始菜单快捷方式、Focus Assist 和用户通知设置，本次未做视觉断言。

### 4.2 任务计划程序

```json
{
  "taskName": "StudyNext-NotificationPoC",
  "exists": true,
  "state": "Ready",
  "lastTaskResult": 0,
  "eventCount": 1,
  "event": {
    "firedAtLocal": "2026-11-12T08:35:45.3968205+08:00",
    "firedAtUtc": "2026-11-12T00:35:45.3968205Z",
    "userName": "45181",
    "computerName": "ASUKA",
    "source": "StudyNext-NotificationPoC"
  },
  "cleanedUp": true
}
```

结论：当前用户可在不提升管理员权限的情况下注册、启动、查询和删除一次性任务；worker 实际执行并写入日志，任务返回码为 0。

### 4.3 没有验证的项目

- 休眠/唤醒后的真实触发时间。
- 系统时间手动调整、跨时区旅行。
- Focus Assist、勿扰模式和通知权限关闭时的行为。
- 安装器升级/卸载时对计划任务和 AUMID 的清理。
- 真实 Electron 可执行文件的 `--check-reminders` 模式（产品尚未实现）。
- 视觉弹窗、通知中心历史、点击跳转。

这些必须作为后续验收项，不能从本次 API 注册成功推导出来。

## 5. 推荐路线

### 阶段 1：v0.4.0 采用 Task Scheduler + 无界面检查模式

理由：

- 不要求先解决代码签名、MSIX/AUMID 和开始菜单快捷方式。
- 当前用户级任务已验证可安装/运行/删除。
- 可以复用现有 SQLite、提醒规则和 `notification_deliveries` 去重。
- 触发时由应用执行一次 `--check-reminders`，读取本地 DB，按当前时间生成一次系统通知，然后退出。
- 失败时不伪造成功；任务日志和同步中心显示失败原因。

需要新增的产品能力：

1. `StudyNext.exe --check-reminders`：无 UI、无 renderer、只读本地 DB，调用系统通知，处理锁和幂等。
2. 安装/卸载时注册/删除一个当前用户任务，任务名带应用 ID 和用户 SID 后缀。
3. 触发器建议每 15 分钟一次（或按最近 DDL 动态重建一次性任务）；`StartWhenAvailable` 开启，默认不启用 `WakeToRun`。
4. 任务动作必须引用安装目录的真实 exe，路径变更时重建。
5. 任务执行时若应用已在运行，交给现有 `ReminderScheduler` 或通过单实例锁避免双发；`notification_deliveries` 仍是最终幂等层。

### 阶段 2：签名和安装器成熟后评估 Scheduled Toast

适用条件：

- 安装器能创建稳定的开始菜单快捷方式和 AUMID。
- 代码签名、升级、卸载路径稳定。
- 能处理通知权限、Focus Assist、时区和系统时间变化。
- 能为每条 DDL 建立/撤销计划通知，并用 tag/group 去重。

### 不建议：后台 Windows 服务作为第一步

服务账户通常不能直接在用户桌面会话显示 Toast；还需要 broker、IPC、服务安装权限和独立升级机制。对单用户桌面应用而言成本明显高于 Task Scheduler。

## 6. 推荐方案的失败处理

| 场景               | 行为                                                            |
| ------------------ | --------------------------------------------------------------- |
| 任务未注册         | 设置页显示“系统级提醒未启用”，不显示成功                        |
| 触发时应用文件缺失 | 记录任务错误；下次启动提示重新注册                              |
| 数据库被锁定       | 短暂重试；仍失败则记录，不重复弹窗                              |
| 通知权限关闭       | 应用内显示权限提示；不假装已发送                                |
| 任务重复执行       | `notification_deliveries` 去重；同一 dueAt 只发一次             |
| 休眠错过           | `StartWhenAvailable` 补跑；超出补发窗口则只在应用启动时补发一次 |
| 用户修改 DDL       | 重建任务的触发器或下次检查时重新计算，旧计划不保留              |

## 7. 验收清单

- [ ] 注册任务后重启应用，任务仍存在且指向正确 exe。
- [ ] 退出应用，等待触发，系统通知出现且只出现一次。
- [ ] 删除/修改 DDL 后，旧提醒不再出现。
- [ ] 休眠 30 分钟后恢复，最多补发一次。
- [ ] 关闭通知权限时不显示“已发送”。
- [ ] 卸载应用后计划任务被清理。
- [ ] 任务计划程序日志可定位失败原因，且不包含课程敏感内容。

## 8. 复现命令

```powershell
# 仅检查环境
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\notification-poc\poc.ps1 -Action status

# 计划 Toast API 注册/移除
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\notification-poc\poc.ps1 -Action scheduled-toast

# 任务计划程序全流程，结束后自动清理
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\notification-poc\poc.ps1 -Action all -DelayMinutes 1
```

## 9. 结论

v0.4.0 推荐先实现“Task Scheduler + `--check-reminders` 无界面检查”作为应用退出后的系统级提醒方案；Scheduled Toast 保留为签名/安装器成熟后的增强项；后台服务暂不采用。现有进程内 `NotificationScheduler` 保持不动，直到新方案通过休眠、权限、重复通知和卸载验收。
