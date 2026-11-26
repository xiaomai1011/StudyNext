# Windows 系统级 DDL 提醒

> 本文合并原 `WINDOWS_NOTIFICATIONS.md` 与 `WINDOWS_NOTIFICATION_POC.md`，并按 `v0.5.0` 的 NEXT-01 实现更新。
> 结论日期：2026-11-25。事实以当前源码为准；未在真实 Windows 安装环境验证的项目明确列为待验收。

## 1. 目标与边界

StudyNext 的提醒分两层：

1. **进程内提醒**：Electron 主进程运行时的 `ReminderScheduler`，负责应用内提醒与系统通知。
2. **系统级提醒**：Windows Task Scheduler 在当前用户登录会话中触发一次性任务，运行 `StudyNext.exe --check-reminders`，由无头检查读取 SQLite 并发送到期系统通知。

系统级提醒不是后台常驻服务，也不是“关机后仍能提醒”。它依赖：

- 安装版应用（开发模式不注册 Task Scheduler 任务）。
- 当前 Windows 用户存在可读取的 SID。
- 任务计划程序可用且当前用户有权注册/删除任务。
- 通知权限开启、系统允许通知、用户已登录桌面会话。

任何一项不满足时，设置页必须显示未启用或失败原因，不得显示“已实现”。

## 2. 进程内提醒

`src/main/notifications/scheduler.ts`：

- `ReminderScheduler` 每 30 秒 tick；普通 tick 只补发最近 2 分钟内到期的提醒（`lateWindowMs = 2 * 60_000`）。
- 启动时按设置补发最近 10 分钟内错过的提醒（`catchUpWindowMs = 10 * 60_000`），补发数量写入 `BootstrapData.reminderRuntime.startupCatchUpCount`。
- 候选条件：任务 `status === 'todo'`、`dueAt` 有效且未过期、提醒规则启用；`isDueAtUnknown()` 的哨兵截止时间直接跳过。
- 去重键为 `taskId:ruleId:dueAt`（`reminderCandidateKey`）；修改 `dueAt` 必须清理旧 `notification_deliveries` 与过期 `notification_delivery_failures`。
- 失败按 1/5/15 分钟退避，最多 4 次（`DELIVERY_MAX_ATTEMPTS = 4`，`DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000]`）；重试时间不得晚于截止时间，否则标记耗尽。
- 失败记录持久化在 `notification_delivery_failures`；成功或任务/截止时间变化后清理。
- 系统不支持 `Notification` 时仍广播应用内 `event:reminder`，并通过 `reminderRuntime.systemNotificationsSupported` 暴露能力状态。

## 3. 系统任务实现

`src/main/notifications/system-reminder.ts` 的 `SystemReminderService`：

- 仅在 `platform === 'win32' && packaged === true` 时启用；开发模式 `supported=false`。
- 任务名：`StudyNext-DDL-${sanitize(hostname)}-${sha256(SID).slice(0,12)}`（`buildSystemReminderTaskName`）。旧版任务名 `StudyNext-DDL-${DOMAIN}-${user}` 仅用于迁移清理。
- 任务动作：`New-ScheduledTaskAction -Execute <安装目录 StudyNext.exe> -Argument '--check-reminders'`。
- 触发器：`New-ScheduledTaskTrigger -Once -At <runAt>`；每次只保留一个一次性任务，随“下一条提醒/重试时间”移动，而不是固定每 15 分钟轮询。
- 设置：`-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)`。
- 主体：`New-ScheduledTaskPrincipal -UserId <当前用户 SID> -LogonType Interactive -RunLevel Limited`；不需要管理员权限，不启用 `WakeToRun`。
- 注册脚本使用 `Register-ScheduledTask -Force`，注册后回读 `Get-ScheduledTask` / `Get-ScheduledTaskInfo` 校验任务存在、可执行路径、参数、SID、下次运行时间与上次返回码。
- 注册时间取 `max(nextReminderMs + 2000, now + 2000)`，避免刚写入就过期。
- 任务所有权校验：执行路径必须是当前安装的 exe、参数包含 `--check-reminders`、principal 的 SID 等于当前用户 SID；不满足时拒绝覆盖/删除，防止误删同名任务。
- 状态保存在数据目录 `notification-system.json`（`StoredSystemReminderState`）：taskName、executablePath、scheduledFor、registered、nextRunAt、lastCheckAt、lastDeliveryAt、lastDeliveryError、lastScheduleError；写入采用临时文件 + rename。
- `initialize()` 清理旧版任务并刷新状态；`syncNextTrigger()` 在启用提醒且有下一条提醒时注册/移动任务，无下一条时删除任务；`repair()` 删除自有任务后重新注册。

`src/main/notifications/headless.ts` 的 `runHeadlessReminderCheck()`：

- 供 `StudyNext.exe --check-reminders` 调用，不创建窗口/Renderer/Portal。
- 无头窗口：`HEADLESS_CATCH_UP_MS = 30 * 60_000`、`HEADLESS_LATE_WINDOW_MS = 30 * 60_000`。
- 处理普通到期候选与持久化失败重试；先 `claimDelivery`，成功清理失败记录，失败 `releaseDelivery` 后写 `notification_delivery_failures` 并计算下一次重试。
- 返回 `checkedAt/candidates/delivered/failed/retriesScheduled/retriesExhausted/errors/nextReminderAt`，主进程据此移动下一次任务。

## 4. 设置与用户可见状态

设置页“DDL 提醒”分区显示：

- 提醒总开关、启动补发开关、每条任务的提醒规则（3 天/1 天/3 小时/1 小时，最小 5 分钟）。
- 系统级提醒状态：是否支持、任务名、是否已注册、下次运行时间、上次检查/投递时间、最近错误、是否需要重新注册。
- “重新注册系统提醒”按钮；注册失败时显示原因，不显示成功。

`SystemReminderStatus` 字段：`supported`、`taskName`、`registered`、`executablePath`、`nextRunAt`、`lastCheckAt`、`lastDeliveryAt`、`lastDeliveryError`、`lastScheduleError`、`lastError`、`needsReregister`。

## 5. 失败处理

| 场景                 | 行为                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| 任务未注册           | 设置页显示“系统级提醒未启用”，不显示成功                                      |
| 无法读取用户 SID     | 阻止注册并记录“无法读取当前 Windows 用户 SID，已阻止注册系统级提醒”           |
| 任务名被其他程序占用 | 拒绝覆盖，报错并停止                                                          |
| 安装路径变化         | 下次 `refreshStatus()` 标记 `needsReregister`，设置页提示重新注册             |
| 触发时应用文件缺失   | 任务失败，记录 `lastTaskResult`；下次启动提示重新注册                         |
| 数据库被锁定         | 无头检查短暂失败并记录错误；不重复弹窗                                        |
| 通知权限关闭         | 显示权限提示，不假装已发送                                                    |
| 任务重复执行         | `notification_deliveries` 唯一约束 + claim 去重；同一 `dueAt` 只发一次        |
| 休眠错过             | `StartWhenAvailable` 补跑；无头检查窗口 30 分钟，超出后由应用启动补发         |
| 用户修改 DDL         | 重新计算下一条提醒；旧 `notification_deliveries` / 失败记录清理，旧计划不保留 |

## 6. 已验证与未验证

### 已验证（2026-11-22 前后，来源：git 历史中的 v0.5.0 测试记录与开发交接）

- 真实 SID 任务注册/查询/删除；任务动作指向当前 exe 且带 `--check-reminders`。
- 无头模式发送系统通知；Action Center 点击通知可冷启动应用。
- 单元测试覆盖任务名、注册脚本、所有权校验、重试策略、失败持久化、无头候选与去重。

### 未验证 / 发布前必须验证

- NSIS 安装、覆盖升级、卸载时任务注册/清理。
- 真实 Task Scheduler 定时触发（不是手动 `Start-ScheduledTask`）。
- 打包版应用中的任务注册（当前 DSH 环境权限限制）。
- 真实通知点击在已安装应用中的行为。
- 多用户/无 SID 环境、睡眠/唤醒、通知权限关闭、SQLite 锁、多个无头进程并发。
- 系统时间手动调整、跨时区变化、Focus Assist/勿扰模式。
- 代码签名与自动更新对任务路径的影响。

## 7. 手工回归步骤

1. 安装 0.5.0 安装包，打开应用，进入“设置 → DDL 提醒”。
2. 确认系统级提醒显示“支持”且任务名包含当前机器名与 SID 摘要。
3. 创建一个 3 分钟后截止的任务，设置“提前 5 分钟”提醒（或使用测试通知），确认任务计划程序中出现一次性任务。
4. 完全退出应用，等待触发；确认系统通知出现且只出现一次。
5. 点击通知，确认通过 `studynext://task/<taskId>` 打开对应任务详情。
6. 修改截止时间，确认旧任务被移动/删除，旧提醒不再出现。
7. 卸载应用，确认计划任务被清理。
8. 全程不记录账号密码、Cookie、Token 或完整敏感 URL。

## 8. 设计取舍与未采用方案

- **Scheduled Toast（`ScheduledToastNotification`）**：需要 AUMID、开始菜单快捷方式、打包身份与通知权限；未签名 NSIS 应用容易失败。保留为签名/安装器成熟后的增强项。
- **后台 Windows 服务**：服务账户通常不能直接在当前桌面会话显示 Toast，且需要额外 broker、IPC、安装权限与升级机制；不作为第一步。
- **Task Scheduler + `--check-reminders`**：当前采用。无需管理员权限、可复用 SQLite 与 `notification_deliveries`、安装/卸载可清理；缺点是依赖用户登录会话与任务计划程序权限。

## 9. 维护规则

- 修改提醒逻辑必须同步更新本文件、[ARCHITECTURE.md](ARCHITECTURE.md) 与 [TESTING.md](TESTING.md)。
- 任何“应用退出后仍可提醒”的描述必须同时说明 Task Scheduler 前提；不得写成无条件后台服务。
- 新增/修改任务计划脚本必须保留所有权校验与旧任务迁移清理，避免误删用户其他任务。
- 真实 Windows 验证结果按日期记录在 [STATUS.md](STATUS.md)，不在本文件堆通过记录。
