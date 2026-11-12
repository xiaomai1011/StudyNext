# StudyNext 工程约束与 Agent 工作指南

本文件面向后续维护者和自动化 Agent。修改项目前先读完本文件，并以可运行、可测试、可回滚为默认目标。

## 1. 产品边界

StudyNext 是学习通第三方桌面客户端，核心价值是：

1. 统一课程、章节、学习点、任务、考试与 DDL。
2. 本地优先的数据、题库、学习快照与提醒。
3. 通过隔离的官方网页视图完成网页端操作。
4. 为未来经授权的数据适配器保留接口；AI 解题仅在用户主动请求时调用其自有服务。

明确不在范围内：

- 自动刷课、挂机、伪造签到、自动考试答题、监考绕过。
- 验证码绕过、反爬规避、私有协议破解、未授权接口访问。
- 在远程网页中暴露 Node.js、文件系统、SQLite 或通用 IPC。
- 将未配置/失败的同步描述为成功。

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
- v0.4.0 的研究文档与 `scripts/notification-poc/` 是设计与独立 PoC，不代表已授权实时适配器；任何真实学习通 Provider 仍必须通过 `docs/V0.4.0_GO_NO_GO.md` 的硬门槛。

## 3. 进程与信任边界

```text
┌──────────────────────── Main process ────────────────────────┐
│ app lifecycle / tray / native notification                   │
│ SQLite (studynext.sqlite)                                    │
│ ReminderScheduler                                            │
│ IPC handlers  ← Zod validation ← preload contextBridge        │
│ PortalService → WebContentsView (sandbox, no preload)         │
└──────────────────────────────────────────────────────────────┘
             ▲ minimal invoke/send              │ load https only
             │                                  ▼
┌──────── Renderer (sandboxed) ────────┐  ┌──── Official website ────┐
│ React UI, no Node access             │  │ untrusted remote content │
│ window.studynext (typed API only)    │  │ no app preload           │
└──────────────────────────────────────┘  └──────────────────────────┘
```

规则：

- 新增 IPC 必须同时更新：`src/shared/ipc.ts`、`src/shared/types.ts`、preload API、main handler，并加 Zod 校验。
- 主进程 handler 必须校验发送者是否为应用主窗口；不要接受任意 `webContents`。
- 渲染器不得直接 `fetch` 学习通私有接口，也不得持有登录态。
- 远程页面只能走 `PortalService`，不得给 `WebContentsView` 注入 preload 或开启 `nodeIntegration`。
- 所有 URL 在进入 Portal 前后都要经过白名单校验，禁止 `javascript:`、`file:`、`data:` 与未知 host。

## 4. 目录职责

| 路径                                  | 职责                                           |
| ------------------------------------- | ---------------------------------------------- |
| `src/main/index.ts`                   | 生命周期、窗口、托盘、原生通知、设置应用       |
| `src/main/ipc.ts`                     | IPC 路由、输入校验、错误转换                   |
| `src/main/storage/store.ts`           | schema、迁移、DAO、演示数据、通知投递 claim    |
| `src/main/notifications/scheduler.ts` | 提醒候选计算、去重投递、启动补发               |
| `src/main/integrations/import.ts`     | CSV/ICS 解析与导入                             |
| `src/main/integrations/snapshot.ts`   | JSON 学习快照解析、去重、课程/章节/任务导入    |
| `src/main/integrations/ai.ts`         | OpenAI 兼容请求、safeStorage Key、响应解析     |
| `src/main/integrations/sync.ts`       | 授权数据适配器接口、同步状态机、快照状态       |
| `src/main/portal/`                    | URL 白名单、WebContentsView 生命周期与安全状态 |
| `src/shared/`                         | 领域类型、常量、纯函数、IPC 合约               |
| `src/renderer/src/pages/`             | 页面级 UI                                      |
| `src/renderer/src/components/`        | 可复用 UI 与编辑器                             |
| `tests/unit/`                         | 纯逻辑、SQLite、调度、导入、安全单测           |
| `tests/e2e/`                          | 真实 Electron 启动、CRUD、持久化与视图截图     |

UI 不能直接依赖学习通接口；所有外部数据必须先经过适配器转成 `Course`/`Task` 领域模型。

## 5. 数据不变量

- `Task.dueAt`、`ReminderRule.createdAt`、`Course.createdAt` 等都是 ISO 8601 字符串。
- 提醒偏移量以分钟存储，最小 5 分钟；预设为 3 天/1 天/3 小时/1 小时。
- `Task.status = 'done'` 时不再生成提醒候选。
- 修改 `dueAt` 必须清理旧 `notification_deliveries`，否则会阻止新提醒。
- 删除任务依赖 SQLite 外键级联删除提醒与投递记录；连接必须开启 `foreign_keys = ON`。
- 通知去重键包含 task、rule、dueAt；不要只按 task 去重，否则改期后无法再次提醒。
- 导入任务以 `(source, external_id)` 唯一；externalId 缺失时使用内容哈希并在导入报告中说明。
- 章节/学习点以 `(course_id, source, external_id)` 唯一，不能按全局 external_id 去重。
- JSON 快照导入的任务外部 ID 必须带课程前缀，避免跨课程冲突。
- 快照导入来源固定为 `import`，不得改写为 `chaoxing` 或返回实时同步成功文案。
- AI Key 只能以 `safeStorage` 密文保存；不得写入日志、渲染器 localStorage、导出文件或测试快照。

## 6. 提醒语义（必须诚实）

- 定时器只存在于 Electron 主进程；**应用完全退出后不会触发提醒**。
- 运行期间默认每 30 秒 tick，普通 tick 仅补发 2 分钟内到期的提醒。
- 启动时如开启补发，检查最近 10 分钟内错过的提醒；补发数量写入 `BootstrapData.reminderRuntime.startupCatchUpCount`。
- 设置页与 README 必须明确这一限制，禁止把系统计划任务/后台服务说成已实现。
- 系统不支持 `Notification` 时不要停掉调度器：仍要广播应用内提醒事件，并通过 `reminderRuntime.systemNotificationsSupported` 暴露能力状态。
- 通知发送失败必须释放 claim，允许后续 tick 重试。

## 7. 同步状态机

`SyncState` 只有：`not_configured`、`syncing`、`success`、`partial`、`failure`。

- 未配置授权适配器：必须返回 `not_configured`，不得返回 `success`。
- 网络失败、权限不足、接口异常：必须保留失败原因，UI 显示失败而不是本地演示数据“同步成功”。
- 部分成功必须列出成功/失败数量与原因。
- 当前 `ChaoxingAuthorizedAdapter.isConfigured()` 固定为 `false`，这是有意设计，不是待修的 bug。
- 接入真实接口前需要合法的开放平台/机构授权；不得用抓包私有接口替代。

## 8. 开发命令

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run build:win
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

新增领域函数要配单测；新增 IPC 要覆盖输入校验；修复提醒/导入/安全/快照/AI 逻辑要加回归测试。新增页面必须加入 `views.spec.ts` 与 `responsive.spec.ts`，E2E 截图应等待 `page-in` 动画（≥300ms）结束后再拍。

## 10. 代码风格

- 使用函数组件与 hooks；不要引入大型状态管理库，跨页状态放 `App.tsx` 并通过 props 传递。
- 优先纯函数、显式类型、早返回；不要在渲染路径做隐式日期解析。
- UI 文案为简体中文，代码标识符、命令和日志保留英文。
- 重要操作必须有 Toast 或内联反馈；失败要可理解、可重试。
- 不添加无用依赖；不为一次性功能引入框架。
- 格式化使用 Prettier；不要手动制造大片无意义 diff。

## 11. 发布与仓库

- 默认不创建 git commit、不 push、不公开仓库，除非用户明确要求。
- `release/`、`out/`、`node_modules/`、`.tmp-*` 不入库。
- Windows 打包使用 `electron-builder.yml`，产物在 `release/`。
- 安装包当前未签名；发布前需要代码签名与更新策略。

## 12. 已知技术债

- 官方入口登录态检测目前基于 URL 路径的启发式判断，不等于真实的 auth token 验证。
- Portal 的白名单只允许学习通域名；自定义入口必须属于这些域名，否则会被拒绝。
- 月视图课程按每周重复渲染，未实现单双周、调休、节假日。
- 提醒依赖主进程运行，未实现 Windows 任务计划程序或常驻服务。
- 同步适配器只有接口与 `not_configured` 状态，没有真实 OAuth。
- 学习快照仅支持手动 JSON 导入；已支持按外部 ID 增量更新、截止变化检测和手动字段冲突保留，但不会主动拉取或自动刷新。
- AI 解题依赖用户自备的 OpenAI 兼容服务，未内置模型；输出质量与服务商策略由用户承担。
- 安装包未签名，未接入自动更新。
- 应用图标为本地生成的占位品牌图标，正式发布前应做视觉定稿。
