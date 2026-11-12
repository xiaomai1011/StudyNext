# Windows 定时通知调研与 StudyNext 提醒边界

- 版本：StudyNext 0.3.0
- 目标：明确“应用运行中提醒”和“应用完全退出后提醒”的能力边界，避免把进程内定时器描述成系统级计划任务。

## 1. 当前实现

`src/main/notifications/scheduler.ts` 提供可替换的 `NotificationScheduler` 接口，默认实现
`ReminderScheduler`：

- Electron 主进程运行期间每 30 秒检查一次到期规则；
- 通过 `notification_deliveries` 表做去重；
- 应用启动时补发最近 10 分钟内错过的提醒（可关闭）；
- 只在主进程存活时工作；应用完全退出后**不会**继续提醒；
- 系统通知不可用时仍会发出应用内 `event:reminder`，不会伪造系统通知；
- 首页和设置页显示“进程运行中”以及下一条提醒时间。

这不是 Windows 系统级计划通知，不能承诺“关机后仍会提醒”。

## 2. Windows 可用的系统级方案

### 方案 A：Windows 计划 Toast（ScheduledToastNotification）

Windows 的 UWP/WinRT Toast API 支持 `ScheduledToastNotification` 和
`ToastNotifier.AddToSchedule`：应用把未来触发时间注册给 Windows，由系统在指定时间显示
Toast。

限制：

- Electron 的 `Notification` API 没有暴露计划通知接口；
- 需要 Windows AppUserModelID、有效的开始菜单快捷方式/打包身份和 Toast 通知权限；
- 通常需要原生 WinRT/Windows App SDK 绑定或独立 helper；
- 应用卸载、通知权限撤销、系统睡眠/唤醒与重复计划需要额外处理；
- 对未签名的 NSIS 应用，通知来源和身份配置更容易失败。

结论：可作为未来“真正退出后提醒”的方向，但本次版本不把未验证的原生绑定包装成已完成功能。

### 方案 B：Windows Task Scheduler + 应用检查参数

用 `schtasks.exe` 注册一次性或每日任务，任务启动 StudyNext.exe 并传入例如
`--check-reminders`。应用以无窗口模式读取 SQLite、发送到期提醒后退出。

优点：不依赖 Electron 的进程存活；Windows 计划任务可跨重启保留。
风险：

- 安装/卸载必须成对清理计划任务；
- 需要防止主应用与检查进程同时发送同一条通知（现有 `notification_deliveries` 仍可复用）；
- 任务计划程序权限、休眠唤醒、用户未登录、安装路径变化均需处理；
- 不能把计划任务误当成“后台常驻服务”。

### 方案 C：后台常驻辅助进程 / Windows 服务

可以做到更可靠的后台轮询，但会引入常驻资源、自动启动、权限和隐私问题；对本项目的
本地优先定位收益有限，暂不采用。

## 3. 推荐路线

1. 0.3.x 保持 `NotificationScheduler` 抽象和进程内实现，明确提示退出后不提醒；
2. 下一阶段先实现“启动时补发 + 托盘常驻”而不是伪装系统计划通知；
3. 若确需退出后提醒，优先验证方案 A（系统计划 Toast）在**打包签名版**上的行为；
4. 方案 B 作为备选，必须提供安装/卸载清理、去重和权限失败提示；
5. 所有方案都要在真实 Windows 10/11 上验证睡眠、重启、权限撤销和时区变化。

## 4. 验收边界

- 不得在 UI、文档或测试中声称当前版本可在应用退出后发送系统通知；
- 测试只验证进程内调度的排序、去重、截止变更清理和启动补发；
- 系统级方案落地前，必须新增真实 Windows 手工回归记录；
- 通知内容不得包含密码、Cookie、Token 或完整账号标识。
