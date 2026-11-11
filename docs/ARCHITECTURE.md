# StudyNext 架构设计

## 1. 设计目标

1. **本地优先**：无学习通账号也能完整使用课程、任务、DDL、日历与提醒。
2. **诚实同步**：没有授权数据源就显示未配置；失败不能伪装成成功。
3. **安全隔离**：远程网页只能看到自己的 WebContents，不能触达 Node、SQLite、文件系统或通用 IPC。
4. **可扩展**：课程/任务/章节/学习点/题目统一领域模型，未来授权适配器、CSV/ICS/JSON 快照都汇入同一存储。
5. **桌面体验**：Windows 原生窗口、托盘、系统通知、窗口状态记忆、深浅色。
6. **可审计的增强能力**：学习快照与 AI 解题都明确来源，不把本地导入伪装成实时同步，不内置共享模型凭据。

## 2. 进程架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron main                                               │
│                                                             │
│  index.ts                                                   │
│   ├─ BrowserWindow (sandbox, contextIsolation, preload)     │
│   ├─ Tray + native Notification                             │
│   ├─ ReminderScheduler ── SQLite                            │
│   ├─ AiService ── safeStorage + OpenAI-compatible HTTPS      │
│   ├─ Snapshot importer ── JSON → Store                       │
│   └─ PortalService ── WebContentsView (persist session)     │
│                                                             │
│  ipc.ts ── Zod validation ── Store / Scheduler / Portal / AI │
└───────────────▲─────────────────────────────┬───────────────┘
                │ contextBridge               │ HTTPS
┌───────────────┴───────────────┐   ┌─────────▼───────────────┐
│ Renderer (React)              │   │ 学习通官方网页           │
│ sandbox: true                 │   │ sandbox: true            │
│ no Node / no ipcRenderer      │   │ no app preload          │
│ window.studynext typed API    │   │ no nodeIntegration       │
└───────────────────────────────┘   └─────────────────────────┘
```

## 3. 目录与模块

```text
src/
├─ main/
│  ├─ index.ts                 应用生命周期、窗口、托盘、通知
│  ├─ ipc.ts                   IPC handler、sender 校验、错误转换
│  ├─ window-state.ts          窗口位置/大小/最大化持久化
│  ├─ storage/store.ts         SQLite 连接、schema、DAO、seed
│  ├─ notifications/scheduler.ts
│  ├─ integrations/import.ts   CSV/ICS
│  ├─ integrations/snapshot.ts JSON 学习快照解析/导入
│  ├─ integrations/ai.ts       OpenAI 兼容请求、Key 加密
│  ├─ integrations/sync.ts     授权适配器接口 + 状态机
│  └─ portal/
│     ├─ security.ts           URL 白名单、webPreferences、安全状态
│     └─ service.ts            WebContentsView 生命周期与跳转拦截
├─ preload/
│  ├─ index.ts                 contextBridge 最小 API
│  └─ index.d.ts               Window 类型声明
├─ renderer/src/
│  ├─ App.tsx                  路由、bootstrap、Toast、全局事件
│  ├─ pages/                   仪表盘/学习中心/课程/任务/日历/题目助手/官方页面/设置
│  ├─ components/              Modal/Toast/TaskEditor/TaskDetail/...
│  └─ lib/format.ts            日期、文案、剩余时间格式化
└─ shared/
   ├─ types.ts                 领域类型 + StudyNextApi
   ├─ ipc.ts                   channel 常量
   ├─ constants.ts             预设、内置入口、白名单根域
   ├─ domain.ts                纯领域函数
   └─ validation.ts            Zod schema
```

## 4. 数据模型

SQLite 文件：`%LOCALAPPDATA%\StudyNext\studynext.sqlite`（可用 `STUDYNEXT_DATA_DIR` 覆盖）。

| 表                        | 作用          | 关键约束                                                           |
| ------------------------- | ------------- | ------------------------------------------------------------------ |
| `courses`                 | 课程与课表    | `schedule_json` 存 `CourseSession[]`；收藏 0/1；`external_id` 可空 |
| `course_chapters`         | 课程章节      | `(course_id, source, external_id)` 唯一；删除课程级联              |
| `study_points`            | 学习点        | `(course_id, source, external_id)` 唯一；记录完成状态/耗时         |
| `tasks`                   | 任务与 DDL    | `status`、`priority`、`kind` CHECK；`(source, external_id)` 唯一   |
| `task_reminders`          | 提醒规则      | `(task_id, offset_minutes)` 唯一；offset ≥ 5 分钟                  |
| `notification_deliveries` | 通知去重      | 主键 `dedupe_key`，task/rule/due_at 三元组                         |
| `questions`               | 题目卡        | 题干/答案/解析/标签 JSON/来源；课程可空                            |
| `settings`                | 键值设置      | JSON 值                                                            |
| `official_entries`        | 官方入口      | 内置/自定义、启用、排序                                            |
| `app_meta`                | schema 版本等 | 迁移锚点；AI Key 密文与快照元数据也存此表                          |

外键开启 `PRAGMA foreign_keys = ON`。删除任务级联清理提醒与投递记录；修改截止时间主动清理旧投递，保证改期后能再次提醒。

### 领域类型

- `Course`：`id/externalId/name/code/teacher/semester/category/color/favorite/schedule/source/sourceUrl`。
- `Chapter`：`id/courseId/externalId/title/sortOrder/progress/points/lastStudiedAt/source`。
- `StudyPoint`：`id/chapterId/courseId/externalId/title/kind/status/durationMinutes/sortOrder/source`；类型包括阅读、视频、测验、讨论、作业。
- `Task`：`id/title/description/courseId/priority/kind/status/dueAt/completedAt/source/externalId/reminders`。
- `QuestionCard`：`id/question/answer/explanation/courseId/tags/source/createdAt/updatedAt`。
- `ReminderRule`：`id/taskId/offsetMinutes/enabled`。
- `SyncStatus`：`state/message/source/lastAttemptAt/lastSuccessAt/detail/snapshot`。
- `BootstrapData`：一次性返回课程、任务、章节、学习点、题库、设置、通知、同步状态、入口、应用信息与提醒运行时信息。

## 5. IPC 边界

渲染器只能访问 `window.studynext`：

- `bootstrap()`
- `tasks.create/update/remove/setCompleted`
- `courses.setFavorite`
- `study.setPointCompleted`
- `questions.create/update/remove`
- `ai.getConfig/updateConfig/ask`
- `settings.update/testNotification`
- `demo.reset`
- `imports.csvIcs/snapshot`
- `sync.status/run`
- `portal.open/close/back/forward/reload/clearSession/openInitialInBrowser/setBounds/securityState`
- `entries.create/updateEnabled/remove`
- `window.minimize/toggleMaximize/close/quit/isMaximized`
- `app.onNavigate/onReminder/onFocusTask/openDataDirectory/openExternal`

主进程处理规则：

1. `assertSender` 只接受主窗口 `webContents`。
2. 所有写操作通过 Zod schema 校验；日期与 URL 在进入存储前再次检查。
3. 统一把内部错误转成 `UserFacingError` 的 message，不把堆栈发给渲染器。
4. 事件通过 `event:navigate`、`event:reminder`、`event:portal-state` 等单向推送。

## 6. 提醒调度

```text
dueAt - offsetMinutes = scheduledFor
```

- 仅对 `status = todo` 且 `dueAt > now` 的任务生成候选。
- 普通 tick 每 30 秒，允许 2 分钟迟到窗口。
- 启动时若启用补发，允许最近 10 分钟窗口内的错过提醒。
- 投递前 `claimDelivery` 写入唯一 key；通知失败 `releaseDelivery` 回滚，允许下次重试。
- 系统不支持 `Notification` 时，调度器继续运行并通过 `event:reminder` 推送应用内提醒；能力状态由 `reminderRuntime.systemNotificationsSupported` 暴露。
- 修改截止时间会删除该任务旧投递；完成/删除任务不再产生候选。
- **进程退出后定时器不存在**。这是明确的产品限制，不伪造后台能力。

## 7. Portal 安全模型

`PortalService` 使用 `WebContentsView`：

```ts
{
  partition: 'persist:studynext-portal',
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  spellcheck: false
}
```

不设置 `preload`。远程页面无法访问 `window.studynext`。

URL 规则：

- 只允许 `https:`。
- host 必须等于或属于 `chaoxing.com` / `xuexitong.com`。
- 拒绝 `javascript:`、`file:`、`data:`、`about:` 以及未知域名。
- `will-navigate`、`will-redirect`、`setWindowOpenHandler`、`will-attach-webview`、下载与权限请求全部拦截。
- 会话隔离在 `persist:studynext-portal`，清空会话会清理 storage 与 cache。

登录状态仅为 UI 提示：

- `passport` 路径判定为未登录；
- `i.chaoxing.com` 判定为已登录；
- 其他页面为未知。
  这不是 token 验证，不应被描述为“已接入账号体系”。

## 8. 导入与同步

### CSV

支持表头别名（中文/英文）：

```text
标题, 课程/所属课程, 截止时间, 优先级, 类型, 提醒, 描述
title, course, due, priority, kind, reminders, description
```

日期支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、ISO 本地时间；提醒支持 `3d`、`1d`、`3h`、`1h`、`30m`、`提前3天`、数字分钟。

### ICS

解析 `VEVENT`、`DTSTART`（DATE 或 DATE-TIME）、UTC `Z`、`TZID`、`DESCRIPTION`、`CATEGORIES`、`UID`；折行展开与转义处理。按 UID 去重。

### JSON 学习快照

`src/main/integrations/snapshot.ts` 接受用户选择的本地 JSON 文件，支持根对象或 `data` 包装：

- `courses[]`：课程元数据、课表；
- `chapters[]`：章节与 `points[]`；
- `homeworks[]` / `exams[]`：转为统一任务；
- 根级或课程级作业都支持；嵌套任务只解析一次。

解析结果使用稳定外部 ID；课程/章节/学习点唯一键均包含 `course_id`，避免不同课程使用相同 `chapter-1` 时互相覆盖。任务外部 ID 带课程前缀，防止跨课程冲突。写入来源为 `import`，同步状态显示“本地快照 · 非实时同步”。

### AI 解题助手

`src/main/integrations/ai.ts`：

- 配置保存在 `app_meta.ai_config`；API Key 使用 Electron `safeStorage` 加密后存 `app_meta.ai_api_key`。
- Base URL 只接受 HTTPS；`localhost`/`127.0.0.1` 的 HTTP 便于本地模型。
- 请求以 OpenAI 兼容 `/chat/completions` 格式发送，超时 50 秒，不记录 Key 或完整请求头。
- 只有用户在题目助手点击“生成思路”时才发起网络请求；结果不会自动写库，需用户确认保存。

### 授权适配器

```ts
interface AuthorizedDataAdapter {
  id: string
  isConfigured(): boolean
  pull(): Promise<CourseBundle>
}
```

`ChaoxingAuthorizedAdapter.isConfigured()` 当前固定 `false`，`pull()` 抛出“学习通授权数据源尚未配置”。`SyncService` 因此返回 `not_configured`，绝不伪造 `success`。

## 9. UI 架构

- `App.tsx` 持有 `BootstrapData`、当前路由、Toast 与全局事件订阅。
- 页面通过 props 接收数据与操作回调，不直接访问 IPC。
- `TaskEditor` 负责表单与提醒规则编辑；`TaskDetail` 展示详情与操作；`CourseDetail` 展示课表与收藏。
- `Study.tsx` 展示课程侧栏、章节与学习点进度；完成状态通过 `study.setPointCompleted` 更新。
- `Questions.tsx` 负责题库 CRUD 与 AI 解题面板；AI Key 仅在主进程解密使用。
- 日历使用纯函数生成月网格/周网格，任务与课程按日期映射。
- 主题使用 `html[data-theme]` 与 CSS 变量；主进程同步 `nativeTheme.themeSource` 与窗口背景色。

## 10. 测试策略

- 单元测试：领域排序/分组/统计、SQLite CRUD/重启、提醒候选/去重、CSV/ICS、JSON 快照、AI 请求构造、URL 白名单与 webPreferences。
- E2E：真实 Electron 启动、首页模拟数据、任务 CRUD、关闭重启持久化、学习点完成、题库 CRUD、快照导入、`window.studynext` 暴露面、所有主要页面与深浅色截图。
- 打包验证：`npm run build:win` 产出 NSIS 安装包；可运行 `release/win-unpacked/StudyNext.exe` 验证 asar 内资源与 preload 路径。

## 11. 关键决策

| 决策                  | 原因                                          | 代价                                 |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| 使用 `node:sqlite`    | 免原生模块编译，Electron 38 内置 Node 22 支持 | API 较新，迁移到更老 Electron 不可用 |
| 无 ORM                | 数据库小、查询可控、打包体积小                | 需要手写映射与迁移                   |
| 日期存 ISO 字符串     | 跨进程/JSON 简单、可排序                      | 展示层必须统一本地化                 |
| 无全局状态库          | 页面规模可控，减少依赖                        | props 传递较多                       |
| Portal 不注入 preload | 最大化隔离远程内容                            | 无法在网页内做深度集成               |
| 快照来源标记 `import` | 本地 JSON 不能冒充实时学习通同步              | 用户需手动更新文件                   |
| AI 使用用户自带 Key   | 不内置共享凭据、不产生平台代答                | 用户需自行配置服务商                 |
| 提醒仅在主进程运行    | 不伪造后台能力                                | 退出后无提醒                         |
| Electron 38.8.6       | 当前测试环境 45 启动崩溃，38 稳定             | 不是最新大版本                       |

## 12. 后续演进

1. 经授权接入 OAuth/课程/作业数据，适配器输出统一 `CourseBundle`。
2. 增加 Windows 计划任务或常驻服务，实现真正的退出后提醒（需明确权限与卸载清理）。
3. 增加 ICS 导出、任务归档、批量操作。
4. 引入数据库迁移版本表与自动备份。
5. 代码签名、自动更新、崩溃上报（默认关闭、需用户同意）。
