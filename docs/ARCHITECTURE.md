# StudyNext 架构设计

本文描述 v0.5.0 的实际实现，不是理想化规划。历史阶段的架构结论以本文和当前源码为准。

## 1. 设计目标

StudyNext 是学习通桌面客户端，目标是把课程、章节、学习点、任务、考试与 DDL 收进一个本地优先的 Windows 应用，同时保持以下边界：

1. **本地优先**：课程、任务、资料、下载记录与提醒保存在本机 SQLite；断网时仍能查看已同步数据。
2. **官方页面优先**：作业编辑、附件上传、草稿保存与提交在隔离的官方页面完成，应用只负责导航、检测与回读。
3. **Web Session 只读同步**：课程、作业、考试、章节、通知、资料与课表通过用户本人已登录的 Web Session 读取。
4. **多账号隔离**：每个学习通账号使用独立 SQLite 工作区，按平台数字 UID 隔离。
5. **诚实状态**：未配置、登录过期、部分成功、失败都必须如实显示，不把页面打开成功当成同步成功。
6. **不进入平台灰区**：不自动刷课、不伪造签到/学习记录、不自动答题、不绕过验证码或监考。

明确不做：AI 解题入口、学习通官方 API 的未授权调用、远程页面内的 Node.js/文件系统/通用 IPC、自动提交作业。

## 2. 进程架构

```text
┌──────────────────────────────── Main process ────────────────────────────────┐
│ app lifecycle / BrowserWindow / tray / global shortcuts                      │
│ SQLite (per-account workspace) / migrations / backups                        │
│ IPC handlers (Zod validation + sender check)                                 │
│ ReminderScheduler + retry policy + Windows Task Scheduler registration       │
│ ChaoxingSessionService → PortalService → WebContentsView (persist partition) │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲ ipcRenderer.invoke / send                  │ load https only
        │                                            ▼
┌──────── Renderer (sandboxed) ────────┐   ┌──── Official website ────────────┐
│ React 19 / Vite / Tailwind + studio  │   │ untrusted remote content          │
│ no Node.js, no direct fetch          │   │ sandbox, contextIsolation, no     │
│ window.studynext typed API           │   │ preload, no nodeIntegration       │
└──────────────────────────────────────┘   └───────────────────────────────────┘
```

关键点：

- Renderer 只能通过 preload 暴露的 `window.studynext` 访问主进程能力；所有 IPC 输入由主进程 Zod 校验，并校验发送者是否为应用主窗口。
- Portal 使用独立持久分区 `persist:studynext-portal`，`WebContentsView` 的 `webPreferences` 为 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`nodeIntegrationInWorker: false`、`nodeIntegrationInSubFrames: false`、`webviewTag: false`、无 preload。
- 主进程可直接复用 Portal Session 发起 `net.request` 下载，但不会把 Cookie 复制到默认 Session，也不向 Renderer 暴露 Cookie/Token。

## 3. 目录与模块

```text
src/main/
  index.ts                    生命周期、窗口、托盘、通知、启动参数
  ipc.ts                      IPC 路由、校验、错误转换
  account-switch.ts           多账号切换与受控重启
  startup-workspace.ts        启动工作区选择/迁移
  window-state.ts             窗口位置与尺寸
  storage/store.ts            schema、迁移、DAO、演示数据、投递 claim
  storage/workspaces.ts       每账号工作区注册表、备份与迁移
  notifications/scheduler.ts  提醒候选、去重、启动补发
  notifications/headless.ts   --check-reminders 无头检查
  notifications/system-reminder.ts  Task Scheduler 注册/查询/删除
  notifications/retry-policy.ts     失败退避
  integrations/import.ts      CSV/ICS 导入
  integrations/snapshot.ts    JSON 快照导入
  integrations/sync.ts        同步状态机与旧 Provider 接口
  integrations/sync-status.ts 同步状态持久化
  integrations/chaoxing/      Web Session 适配器、解析器、凭据、下载
  materials/                  资料下载来源与本地文件核验
  portal/                     URL 白名单、WebContentsView、安全、下载、上传事件
src/preload/                  contextBridge 类型化 API
src/shared/                   领域类型、IPC 合约、纯函数
src/renderer/src/
  App.tsx                     三顶层标签、全局缩放、同步协调、Portal 浮层
  pages/                      Dashboard、CourseWorkspace、Tasks、Calendar、Records、Exams、Notices、Portal、Settings
  components/                 CommandPalette、TaskDetail、TaskEditor、DownloadQueue、LoginDialog、Modal、Toast
  ui/studio.css               Studio 设计 token 与全局样式
tests/unit/                   Vitest 单元测试
tests/e2e/                    Playwright Electron E2E
```

## 4. 数据模型

SQLite 使用 Electron 内置 `node:sqlite` 的 `DatabaseSync`，连接开启 `foreign_keys = ON`。核心表：

| 表                               | 用途                                            |
| -------------------------------- | ----------------------------------------------- |
| `courses`                        | 课程、学期、教学班、教师、颜色、收藏            |
| `course_chapters`                | 章节与小节、平台 chapter id、任务点统计         |
| `study_points`                   | 学习点/任务点、完成状态、来源                   |
| `tasks`                          | 作业/本地任务、平台六态、截止、成绩、批语、附件 |
| `exams`                          | 考试安排                                        |
| `materials`                      | 课程资料、类型、大小、来源 URL                  |
| `downloads`                      | 下载记录、状态、进度、保存路径、附件身份        |
| `material_local_files`           | 本地文件核验表                                  |
| `app_notices`                    | 学校/课程通知                                   |
| `task_change_log`                | 任务字段变更审计                                |
| `task_reminders`                 | 提醒规则与偏移量                                |
| `notification_deliveries`        | 通知投递 claim 与幂等去重                       |
| `notification_delivery_failures` | 失败重试队列与 `last_error`                     |
| `settings`                       | 应用设置                                        |
| `official_entries`               | 课程官方入口 URL                                |
| `app_meta`                       | schema 版本、迁移标记等                         |

数据不变量：

- 所有日期以 ISO 8601 字符串存储；展示时使用本机时区。
- 任务唯一键包含来源与外部 ID；快照导入任务带课程前缀，避免跨课程冲突。
- 章节/学习点唯一键为 `(course_id, source, external_id)`，不能按全局 external_id 去重。
- 平台任务状态六态：`not_submitted`、`submitted`、`pending_review`、`reviewed`、`done`、`unknown`；本地完成状态单独存储，不用逾期覆盖平台状态。
- 课程、任务、成绩、批语、附件使用“未读取 / 有效值 / 平台明确为空”三态更新，不完整详情不得清空历史值。
- 修改 `dueAt` 必须清除旧 `notification_deliveries` 与过期失败记录。
- 删除任务依赖外键级联清理提醒、投递和失败记录。
- `lastCompleteSyncAt` 仅完整成功更新；partial/failure 保留上一次完整成功时间。

## 5. 账号与工作区

- 账号凭据由 `ChaoxingCredentialStore` 使用 Electron `safeStorage`（Windows DPAPI）保存；`StoredAccountV2` 包含 id、username、password、displayName、school、platformUid、lastUsedAt。
- 每个账号按平台数字 UID 派生稳定工作区 id，数据库位于数据目录 `workspaces/` 下；注册表为 `account-workspaces.json`。
- 新账号首次登录后绑定 `platformUid`；历史库归属不明时保留为只读历史库，不自动认领、不覆盖。
- 账号切换通过主进程受控重启：检查作业编辑/上传状态，停止同步与调度器，写入 pending switch，再装载目标工作区。
- 备份使用 `VACUUM INTO` 生成事务一致的 SQLite 副本，并验证表数量与完整性。

## 6. IPC 边界

IPC 合约集中在 `src/shared/ipc.ts`，类型在 `src/shared/types.ts`，preload 只暴露白名单方法。主要分组：

- app：bootstrap、打开数据目录、外部打开、窗口控制；
- tasks：CRUD、完成、历史、附件下载；
- courses/study：课程收藏、学习点；
- settings：读取/更新、测试通知；
- notifications：系统提醒状态、重新注册/修复；
- imports：CSV、ICS、JSON 快照；
- sync：状态、全量/手动同步、取消；
- chaoxing：登录检查、同步、重试、进度、头像、凭据 CRUD、自动登录、账号切换；
- portal：打开/隐藏/关闭、前进后退、刷新、清会话、安全状态、下载/上传/提交事件；
- materials：下载、本地文件核验；
- events：导航、提醒、聚焦任务、窗口最大化、Portal 状态。

新增 IPC 必须同时更新合约、preload、main handler 与 Zod 校验，并为输入校验补单测。

## 7. 学习通同步

```text
Renderer 触发
  → IPC sync/chaoxing
  → ChaoxingSessionService.checkWithOperation / syncWithAuthCheck
  → PortalService 导航到官方页面（登录态检测）
  → ChaoxingSessionAdapter.pull()
  → parsers（课程/作业/考试/章节/通知/资料/课表）
  → Normalizer 写入领域模型
  → SyncService.recordSessionResult()
  → SQLite + Renderer 刷新
```

要点：

- 认证状态四态：`unknown`、`logged_out`、`authenticated`、`expired`。401/403/安全验证页立即停止同步并保留失败原因。
- 同步状态五态：`not_configured`、`syncing`、`success`、`partial`、`failure`。
- 全量同步由主进程串行执行；`useSyncScheduler` 在启动、前台周期、后台恢复、失败退避时触发，间隔可配置 3/5/10/15 分钟或关闭。
- 单课程重试是局部操作，不覆盖全局同步状态；partial 不更新 `lastCompleteSyncAt`。
- 页面解析依赖平台 DOM/HTML，解析器必须保持可观测、可回退；任何页面打开成功都不等于同步成功。

详细能力矩阵与授权边界见 [CHAOXING_INTEGRATION.md](CHAOXING_INTEGRATION.md)。

## 8. Portal 安全

- 仅允许 `chaoxing.com` 与 `xuexitong.com` 及其子域；SSO 跳转需在可信域名列表内。
- 禁止 `javascript:`、`file:`、`data:` 与未知 host。
- `will-navigate` 与 `setWindowOpenHandler` 双重校验；新窗口一律拒绝或转由系统浏览器打开。
- 远程页面不注入 preload，不开启 Node.js，不暴露通用 IPC。
- 所有 URL 在日志与 UI 中使用脱敏显示，不记录查询参数中的敏感 token。
- 下载在 Portal Session 内发起；跨源 Referer 由 `webRequest.onBeforeSendHeaders` 注入，避免 `net.request` 直接设置跨源 Referer 触发 `ERR_BLOCKED_BY_CLIENT`。

## 9. 提醒调度

### 9.1 进程内

- `ReminderScheduler` 默认每 30 秒 tick；普通 tick 只投递 2 分钟内到期的提醒。
- 启动时如开启补发，检查最近 10 分钟内错过的提醒，数量写入 `reminderRuntime.startupCatchUpCount`。
- 去重键：`taskId:ruleId:dueAt`；投递前 claim，失败释放 claim 并记录 `notification_delivery_failures`。
- 失败按 1/5/15 分钟退避，最多 4 次；任务完成、删除或截止时间变化后清理旧失败记录。

### 9.2 Windows 系统提醒

- `--check-reminders` 无头模式：不创建窗口/Renderer/Portal/同步，只读取当前工作区 SQLite、检查到期提醒、发送通知并更新投递记录。
- 注册当前用户级一次性 Task Scheduler 任务：任务名 `StudyNext-DDL-<host>-<SID 摘要>`，动作 `StudyNext.exe --check-reminders`，`StartWhenAvailable`，不启用 WakeToRun，不要求管理员。
- 通知点击通过 `studynext://task/<id>` 激活，支持冷启动、单实例转发与 Renderer 就绪握手。
- NSIS 安装/卸载调用 `--install-reminders` / `--uninstall-reminders`，只操作当前用户任务，不删除用户数据。
- 真实限制：系统任务未注册、系统通知被关闭、睡眠、SQLite 锁、多用户无 SID 等场景仍可能失败，必须在 UI 中如实显示。

详见 [WINDOWS_REMINDERS.md](WINDOWS_REMINDERS.md)。

## 10. UI 架构

- 顶层导航为 Studio 三标签：`今天`、`课程`、`作业`；标题栏同时提供全局搜索、缩放、通知、账号、设置与窗口控制。
- 路由映射：`dashboard`/`calendar` → Dashboard/Calendar；`courses`/`study`/`materials` → CourseWorkspace；`tasks`/`records`/`exams` → Tasks；`notices` → Notices；`settings` → Settings。
- 跨页状态集中在 `App.tsx`，页面通过 props 传递；不引入大型状态管理库。
- 组件：`CommandPalette`（Ctrl+K）、`TaskDetail`、`TaskEditor`、`DownloadQueue`、`LoginDialog`、`Modal`、`ToastStack`。
- 设计 token 在 `src/renderer/src/ui/studio.css`；支持浅色/深色、100%/125%/150% 缩放与 `prefers-reduced-motion`。
- 日期展示统一使用本机时区；渲染路径不做隐式日期解析。

## 11. 测试策略

- **单元测试**：Vitest，覆盖纯函数、SQLite schema/迁移、提醒调度与重试、导入、安全、同步状态、IPC 校验。
- **E2E**：Playwright 启动真实 Electron，覆盖导航、视图渲染、任务 CRUD、资料工作流、Portal 安全、账号切换、提醒与响应式。
- **截图**：`views.spec.ts` 在浅色/深色与不同缩放下截取主要视图；截图前等待 `page-in` 动画（≥300ms）。
- **测试隔离**：E2E 使用工作区内临时 `STUDYNEXT_DATA_DIR`，不触碰真实 `%LOCALAPPDATA%`；测试结束清理进程与目录。
- **真实账号验收**：由用户本人在真实环境执行；Mock/单测通过不等于真实平台通过。

详细命令与最近基线见 [TESTING.md](TESTING.md)。

## 12. 关键决策

1. **Web Session 而非官方 API**：官方 OAuth/机构 API 未获证实与授权；当前以用户本人 Web Session 只读同步为准，不把第三方项目当授权证明。
2. **官方页面写操作**：作业编辑、附件上传、草稿保存与提交留在官方页面，避免协议漂移与平台行为不一致；应用只做提交检测与回读。
3. **本地优先**：SQLite 保存已同步数据，断网仍可查看；同步失败不覆盖最后有效数据。
4. **多账号独立库**：按平台 UID 隔离，避免账号串数据与历史库覆盖。
5. **系统提醒双通道**：进程内调度保证运行时可提醒；Task Scheduler 无头检查覆盖应用退出后的场景，二者共用幂等键。
6. **移除 AI 解题**：产品方向已明确 AI 解题下线，避免未经授权的自动答题与隐私风险；仅保留旧库只读兼容。

## 13. 后续演进

- 官方 API/机构授权接入：必须先获得书面授权、接口文档、scope 与测试账号。
- 资料分页、下载失败原因持久化、复杂课表与单双周建模。
- 更细粒度的同步进度与错误分类。
- 多 Provider 抽象：保留学习通深度集成，同时支持其他教育平台适配器。
- 代码签名、自动更新与正式品牌视觉。
