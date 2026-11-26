# StudyNext 工程约束与 Agent 工作指南

本文件面向后续维护者与自动化 Agent。修改项目前先读完本文件，并以可运行、可测试、可回滚为默认目标。

## 1. 产品边界

StudyNext 是学习通第三方桌面客户端，核心价值是：

1. 统一课程、章节、学习点、任务、考试与 DDL。
2. 本地优先的数据、题库、学习快照与提醒。
3. 通过隔离的官方网页视图完成网页端操作。
4. 为未来经授权的数据适配器保留接口。

明确不在范围内：

- 自动刷课、挂机、伪造签到、自动考试答题、监考绕过。
- 验证码绕过、反爬规避、私有协议破解、未授权接口访问。
- 在远程网页中暴露 Node.js、文件系统、SQLite 或通用 IPC。
- 将未配置/失败的同步描述为成功。
- AI 解题入口。该功能已从产品移除，禁止恢复；旧数据库中的 `questions`/`ai_config` 只做只读迁移兼容。

如果需求与上述边界冲突，应实现等价的本地能力（例如 CSV/ICS 导入、手动任务），并保持诚实状态提示。

## 2. 技术约束

- Electron **45.3.0**、electron-vite 6、Vite 8、React 19、TypeScript 5.9、Tailwind 4。
- 项目是 CommonJS 包，没有 `"type": "module"`；主进程与 preload 输出 CJS。
- 数据库使用 Electron 内置 Node 的 `node:sqlite`（`DatabaseSync`），不要引入 `better-sqlite3` 等原生模块，除非同时完成 ABI 与打包验证。
- `@shared` 指向 `src/shared`，`@renderer` 指向 `src/renderer/src`；不要用脆弱的相对路径穿透层。
- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。新增代码必须通过 `npm run typecheck`。
- 日期以 ISO 字符串跨 IPC/数据库传输；展示时使用本机时区。禁止在数据层存“本地化字符串”。
- **所有源码、测试、JSON、Markdown 必须是 UTF-8（无 BOM）**。禁止使用 Windows PowerShell 的 `Get-Content`/`Set-Content` 默认编码（CP936）批量修改含中文的文件；优先使用编辑器/`write`、Python `encoding='utf-8'` 或 Prettier，并在修改后运行 `npm run format:check` 与目标文件编码检查。历史上的 P1 CP936 乱码事故见 `docs/ISSUES.md`。
- 不在源码、日志、测试快照中写入真实账号、密码、Cookie、Token。
- 学习通集成基于用户本人 Web Session，不代表获得官方 API 授权；任何真实 Provider 仍必须通过 `docs/CHAOXING_INTEGRATION.md` 的硬门槛。

## 3. 进程与信任边界

```text
┌──────────────────────────────── Main process ────────────────────────────────┐
│ app lifecycle / tray / native notification / Task Scheduler registration     │
│ SQLite (per-account workspace) / ReminderScheduler / headless reminder check  │
│ IPC handlers ← Zod validation ← preload contextBridge                        │
│ ChaoxingSessionService → WebContentsView (sandbox, no preload)               │
└──────────────────────────────────────────────────────────────────────────────┘
             ▲ minimal invoke/send                        │ load https only
             │                                             ▼
┌──────── Renderer (sandboxed) ────────┐      ┌──── Official website ────┐
│ React UI, no Node access             │      │ untrusted remote content │
│ window.studynext (typed API only)    │      │ no app preload           │
└──────────────────────────────────────┘      └──────────────────────────┘
```

规则：

- 新增 IPC 必须同时更新：`src/shared/ipc.ts`、`src/shared/types.ts`、preload API、main handler，并加 Zod 校验。
- 主进程 handler 必须校验发送者是否为应用主窗口；不要接受任意 `webContents`。
- 渲染器不得直接 `fetch` 学习通私有接口，也不得持有登录态。
- 远程页面只能走 `PortalService`，不得给 `WebContentsView` 注入 preload 或开启 `nodeIntegration`。
- 所有 URL 在进入 Portal 前后都要经过白名单校验，禁止 `javascript:`、`file:`、`data:` 与未知 host。
- 账号密码只能在主进程与官方登录页之间传递；保存时使用 Electron `safeStorage`（Windows DPAPI），不得写入日志、渲染器 localStorage、导出文件或测试快照。

## 4. 目录职责

| 路径                                        | 职责                                                           |
| ------------------------------------------- | -------------------------------------------------------------- |
| `src/main/index.ts`                         | 生命周期、窗口、托盘、原生通知、启动参数                       |
| `src/main/ipc.ts`                           | IPC 路由、输入校验、错误转换                                   |
| `src/main/account-switch.ts`                | 多账号切换、受控重启                                           |
| `src/main/startup-workspace.ts`             | 启动时选择/迁移工作区                                          |
| `src/main/storage/store.ts`                 | schema、迁移、DAO、演示数据、通知投递 claim                    |
| `src/main/storage/workspaces.ts`            | 每账号独立 SQLite 工作区注册表与备份                           |
| `src/main/notifications/scheduler.ts`       | 提醒候选计算、去重投递、启动补发                               |
| `src/main/notifications/headless.ts`        | `--check-reminders` 无头提醒检查                               |
| `src/main/notifications/system-reminder.ts` | Windows Task Scheduler 注册/查询/删除                          |
| `src/main/notifications/retry-policy.ts`    | 通知失败退避策略                                               |
| `src/main/integrations/import.ts`           | CSV/ICS 解析与导入                                             |
| `src/main/integrations/snapshot.ts`         | JSON 学习快照解析、去重、课程/章节/任务导入                    |
| `src/main/integrations/sync.ts`             | 同步状态机、快照状态、旧 Provider 接口                         |
| `src/main/integrations/sync-status.ts`      | 同步状态持久化与文案映射                                       |
| `src/main/integrations/chaoxing/`           | Web Session 适配器、解析器、凭据、下载                         |
| `src/main/materials/`                       | 资料下载来源解析与本地文件核验                                 |
| `src/main/portal/`                          | URL 白名单、WebContentsView 生命周期、安全状态、下载与上传事件 |
| `src/shared/`                               | 领域类型、常量、纯函数、IPC 合约                               |
| `src/renderer/src/pages/`                   | 页面级 UI：今天/课程/作业/通知/设置                            |
| `src/renderer/src/components/`              | 可复用 UI、任务详情、命令面板、下载队列                        |
| `src/renderer/src/ui/`                      | Studio 设计 token 与全局样式                                   |
| `tests/unit/`                               | 纯逻辑、SQLite、调度、导入、安全单测                           |
| `tests/e2e/`                                | 真实 Electron 启动、CRUD、持久化与视图截图                     |

UI 不能直接依赖学习通接口；所有外部数据必须先经过适配器转成 `Course`/`Task` 等领域模型。

## 5. 数据不变量

- `Task.dueAt`、`ReminderRule.createdAt`、`Course.createdAt` 等都是 ISO 8601 字符串。
- 提醒偏移量以分钟存储，最小 5 分钟；预设为 3 天/1 天/3 小时/1 小时。
- `Task.status = 'done'` 时不再生成提醒候选。
- 修改 `dueAt` 必须清理旧 `notification_deliveries` 与过期 `notification_delivery_failures`，否则会阻止新提醒或错误重试。
- 删除任务依赖 SQLite 外键级联删除提醒与投递记录；连接必须开启 `foreign_keys = ON`。
- 通知去重键包含 task、rule、dueAt；不要只按 task 去重，否则改期后无法再次提醒。
- 导入任务以 `(source, external_id)` 唯一；externalId 缺失时使用内容哈希并在导入报告中说明。
- 章节/学习点以 `(course_id, source, external_id)` 唯一，不能按全局 external_id 去重。
- JSON 快照导入的任务外部 ID 必须带课程前缀，避免跨课程冲突。
- 快照导入来源固定为 `import`，不得改写为 `chaoxing` 或返回实时同步成功文案。
- 每个学习通账号按数字 UID 使用独立 SQLite 工作区；不得覆盖历史库，不得把未知归属的历史库自动认领。
- `lastCompleteSyncAt` 只在完整成功时更新；partial/failure 不得冒充完整成功。

## 6. 提醒语义（必须诚实）

- 进程内 `ReminderScheduler` 默认每 30 秒 tick；普通 tick 仅补发 2 分钟内到期的提醒。
- 启动时如开启补发，检查最近 10 分钟内错过的提醒；补发数量写入 `BootstrapData.reminderRuntime.startupCatchUpCount`。
- 应用完全退出后，只有在 Windows 任务计划程序任务成功注册的前提下，`StudyNext.exe --check-reminders` 才能发送系统通知；不得把未注册或注册失败的状态说成已实现。
- 系统任务为当前用户一次性动态任务，任务名使用当前用户 SID 的稳定摘要；不使用管理员权限，不启用 WakeToRun。
- 通知失败按 1/5/15 分钟有界退避，最多 4 次；失败记录持久化，成功或任务/截止时间变化后清理。
- 通知点击通过 `studynext://task/<taskId>` 激活；冷启动、单实例转发与缺失任务降级必须保持可用。
- 系统不支持 `Notification` 时不要停掉调度器：仍要广播应用内提醒事件，并通过 `reminderRuntime.systemNotificationsSupported` 暴露能力状态。
- 设置页与 README 必须明确提醒限制，禁止把系统计划任务/后台服务说成无条件可用。
- 真实 Windows 安装/升级/卸载、Task Scheduler 定时触发、多用户/睡眠/SQLite 锁等仍未完成发布级验收，见 `docs/STATUS.md`。

## 7. 同步状态机

`SyncState` 只有：`not_configured`、`syncing`、`success`、`partial`、`failure`。

- 未配置授权适配器：必须返回 `not_configured`，不得返回 `success`。
- 网络失败、权限不足、接口异常：必须保留失败原因，UI 显示失败而不是本地演示数据“同步成功”。
- 部分成功必须列出成功/失败数量与原因。
- 当前真实集成走用户本人 Web Session：`ChaoxingSessionService` → `ChaoxingSessionAdapter.pull()` → parsers → `SyncService.recordSessionResult()`。
- `src/main/integrations/sync.ts` 中的 `ChaoxingAuthorizedAdapter.isConfigured()` 固定为 `false` 是历史占位设计，不是待修的 bug；不要用它替代 Web Session 状态。
- 登录状态为 `unknown/logged_out/authenticated/expired`；401/403/安全验证页必须立即停止同步并保留失败原因。
- 任何“页面打开成功”都不等于同步成功，不增加同步计数。
- 接入真实官方 API 前需要合法的开放平台/机构授权；不得用抓包私有接口替代。

## 8. 开发命令

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run build:win
npm run verify:release
npm run format:check
```

本项目所在环境可能设置了 `ELECTRON_RUN_AS_NODE=1`，GUI/E2E 启动前要清除。Playwright 必须传：

```text
--no-sandbox --disable-gpu --user-data-dir=<工作区内可写目录>
```

并且设置 `STUDYNEXT_DATA_DIR` 到同一目录，避免系统临时目录的 Chromium 锁权限问题。

## 9. 测试要求

提交前至少运行：

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:e2e`（涉及 Electron/窗口/Portal/持久化时）

新增领域函数要配单测；新增 IPC 要覆盖输入校验；修复提醒/导入/安全/快照/同步逻辑要加回归测试。新增页面必须加入 `views.spec.ts` 与 `responsive.spec.ts`，E2E 截图应等待 `page-in` 动画（≥300ms）结束后再拍。

详细测试矩阵与最近基线见 `docs/TESTING.md`。

## 10. 代码风格

- 使用函数组件与 hooks；不要引入大型状态管理库，跨页状态放 `App.tsx` 并通过 props 传递。
- 优先纯函数、显式类型、早返回；不要在渲染路径做隐式日期解析。
- UI 文案为简体中文，代码标识符、命令和日志保留英文。
- 重要操作必须有 Toast 或内联反馈；失败要可理解、可重试。
- 不添加无用依赖；不为一次性功能引入框架。
- 格式化使用 Prettier；不要手动制造大片无意义 diff。

## 11. 文档维护规则

长期文档只保留以下入口：

- `README.md`：产品介绍、功能、快速开始、文档索引。
- `AGENTS.md`：工程约束与维护规则。
- `docs/ARCHITECTURE.md`：进程架构、数据模型、同步、提醒、测试策略。
- `docs/FEATURE_MAP.md`：功能实现方式与真实程度。
- `docs/CHAOXING_INTEGRATION.md`：学习通能力矩阵、协议、授权与安全边界。
- `docs/WINDOWS_REMINDERS.md`：系统级 DDL 提醒实现与真实限制。
- `docs/TESTING.md`：测试策略、命令与带日期的基线快照。
- `docs/ISSUES.md`：当前已知问题与工程教训。
- `docs/ROADMAP.md`：路线、优先级与验收原则。
- `docs/STATUS.md`：当前开发状态、未完成项与验证记录。
- `docs/CHANGELOG.md`：版本变更记录。

规则：

1. 不再新增 `docs/reports/` 过程报告、checkpoint 总结或一次性审计文档；结论写入上述长期文档或 `CHANGELOG.md`。
2. 不保留重复的历史计划、旧交接、旧验收报告；需要历史时查 git 历史，不在工作区保留副本。
3. 改动功能时同步更新 `README.md`、`docs/FEATURE_MAP.md`、`docs/STATUS.md`；改动架构/同步/提醒时同步更新 `docs/ARCHITECTURE.md` 与对应专题文档。
4. 测试基线统一记录在 `docs/TESTING.md`，必须带日期；README 不写易过期的测试数量。
5. 所有事实以当前源码、`npm run typecheck`、测试结果与最近一次真实账号验证为准；文档中的历史结论必须标日期。
6. 截图只保留 `docs/screenshots/v0.5/` 下的当前关键界面；过程截图、对比图与一次性验证图不入库。
7. 文档链接使用相对路径，提交前运行链接检查；不得链接已删除的 `docs/reports/` 文件。

## 12. 发布与仓库

- 默认不创建 git commit、不 push、不公开仓库，除非用户明确要求。
- `release/`、`out/`、`node_modules/`、`.tmp-*`、`test-results/` 不入库。
- Windows 打包使用 `electron-builder.yml`，产物在 `release/`。
- 安装包当前未签名；发布前需要代码签名与更新策略。
- 发布前必须核对 `scripts/verify-release.cjs` 与 `release/manifest` 的哈希、文件大小和版本号。

## 13. 已知技术债

- 安装包未签名，未接入自动更新。
- 真实 Windows 安装/覆盖升级/卸载、Task Scheduler 定时触发与真实通知点击仍需目标环境验收。
- 学习通页面解析依赖 DOM/HTML，平台改版可能导致部分字段失败；解析器必须保持可观测、可回退。
- 部分作业不返回提交时间；详情页未完整读取时保持 `unread`，不得猜测。
- 资料分页只完成部分验证；下载失败原因尚未持久化到数据库。
- 多用户/无 SID 环境、睡眠唤醒、通知权限关闭、SQLite 锁与并发无头检查仍未系统验证。
- 应用图标为本地生成的占位品牌图标，正式发布前应做视觉定稿。
