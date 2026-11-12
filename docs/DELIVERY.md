# StudyNext 0.3.0 交付报告

- 项目目录：`D:\Documents\deepseek-harness\default-workspace\studynext`
- 版本：`0.3.0`
- 完成日期：2026-11-12
- 技术栈：Electron 45.3.0、React 19、TypeScript 5.9、Vite 8、Tailwind CSS 4、SQLite（`node:sqlite`）、Vitest、Playwright、electron-builder
- Windows 安装包：`release/StudyNext-Setup-0.3.0.exe`
- 安装包大小：125,169,347 bytes（约 119.37 MiB）
- SHA-256：`FCAFEED57E798D47E94F5ECF3DDC18B46BDD7BA63AD68B07FA25BC1EBE5A54D1`

## 1. 本轮优化结论

本轮依据“真实数据接入与可靠性迭代”要求，继续沿用已验证的 Electron + React 架构，不把项目改写成未经验证的 MyGo/Tauri/Go 客户端。落地重点是：

1. 修复本地数据目录静默回退临时目录的问题：无可用目录时明确报错并退出。
2. 将 Electron 升级到 45.3.0，在真实 E2E 与打包版中验证启动。
3. 增加可配置校园 SSO 域名、登录状态机、脱敏导航日志与 Portal 会话清理。
4. 任务模型增加完成来源、字段来源、手动字段保护、外部 ID 与变更历史；快照支持增量更新、截止变化检测与冲突保留。
5. 将提醒调度抽象为 `NotificationScheduler`，保留进程内实现并记录 Windows 系统级通知方案。
6. 重写学习通接入可行性报告：官方 OAuth 无公开个人入口，`xuexitong-cli` 仅作只读研究，不复制、不未授权调用。
7. 保留学习中心、题库、AI 助手、CSV/ICS/JSON 导入、Portal 隔离与本地优先数据。自动刷课、自动签到、考试代答、验证码绕过、反爬与私有协议调用仍未实现，也不会被包装成同步成功。

## 2. 完成功能

### 2.1 桌面应用外壳

- 无边框主窗口、自定义标题栏、最小化/最大化/关闭。
- 左侧导航、统一设计系统、响应式布局，最小窗口 1080×700。
- 系统托盘：打开应用、今日待办、任务中心、课程中心、DDL 提醒开关、打开数据目录、退出。
- 关闭窗口最小化到托盘，可在设置中关闭；关闭该设置后退出应用。
- 窗口位置、尺寸与最大化状态持久化，非法或离屏状态自动回退。
- 单实例锁；深浅色与跟随系统主题；打包版可选开机启动。
- 主进程数据目录按 `%LOCALAPPDATA%\StudyNext`、应用数据目录依次尝试，支持 `STUDYNEXT_DATA_DIR` 覆盖；候选路径均不可写时明确报错退出，**绝不静默回退临时目录**。

### 2.2 首页仪表盘

- 今日待办、逾期提示、未来 7 天截止、完成率、课程与收藏统计。
- 今日课程时间线、近期焦点任务、最近通知演示列表。
- 数据来源、最近同步/导入时间与运行模式提示。
- 明确区分演示数据、CSV/ICS 导入、本地学习快照与未配置的实时适配器。

### 2.3 课程中心

- 课程卡片网格，支持名称、代码、教师搜索。
- 分类筛选、收藏筛选、收藏切换。
- 课程详情：课表、任务数量、课程信息、官方页面入口。
- 5 门本地演示课程，含完整周课表。

### 2.4 学习中心

- 按课程浏览章节与学习点，展示阅读、视频、测验、讨论类型与预计耗时。
- 学习点完成/取消完成；章节与课程进度按学习点实时重算。
- 课程侧栏搜索、章节卡片、总体进度与完成统计。
- 演示数据含 5 门课程、15 个章节、60 个学习点。
- 空状态提供 JSON 学习快照导入入口。

### 2.5 题目助手与可选 AI

- 题目卡新增、查看、编辑、删除、搜索，支持课程归属、标签、答案、解析和来源。
- 按课程筛选；来源区分手动、导入与 AI 生成。
- 可选接入用户自己的 OpenAI 兼容服务：启用开关、Base URL、模型、API Key。
- API Key 使用 Electron `safeStorage` 加密后保存在主进程；不写日志、不进入渲染器持久化、不随题库导出。
- Base URL 默认只接受 HTTPS；localhost HTTP 仅用于本地模型。
- 只有用户主动点击“生成思路”才发送当前题目；AI 结果仅供参考，不自动提交作业或考试。
- 未配置 AI 时显示明确提示，不伪造 AI 回答。

### 2.6 JSON 学习快照

- 支持根对象或 `data` 包装的 JSON，字段包括 `courses`、`chapters`、`points`、`homeworks`、`exams`。
- 课程、章节、学习点按 `(course_id, source, external_id)` 去重；任务外部 ID 带课程前缀，避免跨课程冲突。
- 作业/考试转为统一任务，返回新增、更新、跳过计数、警告和结构化错误。
- 快照数据来源固定为 `import`；标题栏、仪表盘和设置页均显示“本地快照 · 非实时同步”。
- 同一外部 ID 重复导入会更新任务；截止变化清理旧通知投递并计入 `deadlineChanges`；手动字段冲突保留并返回 `conflicts`。
- 结构示例与完整说明见 [OPTIMIZATION.md](OPTIMIZATION.md)。

### 2.7 任务中心

- 完整任务 CRUD：新增、查看、编辑、完成/恢复、删除。
- 字段：标题、描述、课程归属、优先级、任务类型、截止时间、提醒规则。
- 按截止时间、优先级、创建时间排序；按状态、优先级、课程筛选与关键词搜索。
- 按逾期、今天、三天内、以后、已完成分组。
- 详情弹窗展示课程、截止时间、剩余时间、提醒、来源、完成方式、外部标识与保留的手动字段。
- 数据层记录任务变更历史：导入/手动来源、截止变化、字段差异与本地完成保护。
- 操作反馈 Toast，删除二次确认。

### 2.8 DDL 提醒

- 预设提前 3 天、1 天、3 小时、1 小时，可多选。
- 自定义提醒分钟数，任务级独立调整。
- 提醒规则持久化 SQLite。
- 主进程每 30 秒检查；启动时补发最近 10 分钟内错过的提醒，可关闭。
- 修改截止时间清理旧投递记录；完成、删除任务不再提醒。
- `notification_deliveries` 去重；通知失败释放占位并允许重试。
- 系统通知不可用时仍广播应用内提醒事件，不静默丢失 DDL。
- `NotificationScheduler` 已抽象为接口，主进程通过工厂创建，便于后续替换为 Windows 计划任务实现；当前实现仍只在应用进程存活时运行。
- **应用完全退出后不会继续定时**；界面与文档均明确这一限制，系统级方案见 [WINDOWS_NOTIFICATIONS.md](WINDOWS_NOTIFICATIONS.md)。

### 2.9 日历

- 月视图：任务事件、课程圆点、选中日期议程。
- 周视图：8:00–21:00 时间轴、课程块、任务标记。
- 上/下月、上/下周、回到今天。
- 点击任务打开详情；侧栏显示当天课程与截止任务。
- 每周起始日可在设置中选择周一或周日。

### 2.10 本地数据与设置

- SQLite schema、版本迁移、外键、索引与 DAO。
- 课程、章节、学习点、题目、任务、提醒、设置、官方入口、通知投递与元数据本地持久化。
- 5 门课程、15 项任务、15 个章节、60 个学习点的演示数据；一键恢复。
- 支持 CSV/ICS 导入、JSON 学习快照导入、演示数据重置。
- 不硬编码账号、密码、Cookie 或 Token；默认不上传个人数据。

### 2.11 学习通官方页面兼容层

- `WebContentsView` 承载官方网页，独立持久化分区 `persist:studynext-portal`。
- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 preload。
- URL 白名单仅允许 `https`、无 userinfo 的 `chaoxing.com` / `xuexitong.com` 及其子域；校园 SSO 另需显式授权。
- 可配置校园 SSO 域名；只允许用户明确添加的 HTTPS 精确域名或子域，登录仍由用户在官方页面手动完成。
- 危险跳转、非白名单弹窗、下载、权限请求与 `webview` 注入均被拦截。
- 页面加载、失败、阻断、登录状态（unknown/logged_out/logged_in）与安全状态展示。
- 登录由用户在官方页面手动完成，应用不读取、不记录、不注入密码或 Cookie。
- 导航诊断日志最多 30 条，只保存动作、允许/拦截原因与去掉 query/hash 的 URL；不保存 Cookie、Token 或页面内容。
- 支持系统浏览器回退、清空官方会话、前进/后退/刷新、清空导航日志。
- 官方入口启用/停用、自定义入口、排序。
- 学习通授权数据适配器接口已定义，但当前固定 `not_configured`，不伪造同步成功；接入可行性见 [CHAOXING_INTEGRATION_FEASIBILITY.md](CHAOXING_INTEGRATION_FEASIBILITY.md)。

### 2.12 CSV / ICS 导入

- CSV 支持中英文字段别名、引号、BOM、优先级/类型、提醒时长解析。
- ICS 支持 `VEVENT`、全天事件、UTC、`TZID`、折叠行、UID 去重。
- 导入自动创建缺失课程，按外部 ID 去重。
- 返回成功/失败/部分成功结构，失败不会写成成功状态。

## 3. 技术选型与原因

| 技术                      | 原因                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Electron 45.3.0           | 当前稳定版；Windows 原生窗口、托盘、通知、WebContentsView；已在真实 E2E 与打包版验证 |
| React 19 + TypeScript     | 组件化 UI；严格类型降低 IPC 与领域模型错误                                           |
| Vite / electron-vite      | 快速开发与三端构建；主进程/preload/renderer 清晰分离                                 |
| Tailwind CSS 4 + CSS 变量 | 统一设计令牌，实现深浅色与响应式，不引入重型 UI 框架                                 |
| SQLite `node:sqlite`      | 随 Electron 内置，避免 better-sqlite3 等原生模块的 ABI 与打包风险                    |
| date-fns / date-fns-tz    | 本地时区、周/月计算与提醒时间可靠，避免手写日期边界                                  |
| Zod                       | IPC 边界输入校验，避免渲染器传入非法数据                                             |
| safeStorage + OpenAI 兼容 | 用户自带 Key，系统加密存储；不内置共享凭据                                           |
| Vitest                    | 领域函数、存储、调度、导入、快照、AI 解析与安全逻辑单测                              |
| Playwright Electron       | 真实 Electron 启动、窗口、持久化、新页面与 WebContentsView 隔离                      |
| electron-builder          | Windows NSIS 安装包与免安装目录                                                      |

Electron 45.3.0 已在本轮 E2E、生产构建和打包版启动验证中通过；此前 38.8.6 的默认 profile 启动崩溃已查明与本机默认路径/旧版本有关，不能直接归因于 45 本身。

## 4. 创建与修改的文件

项目当前包含 95 个受版本管理的项目文件（源码、测试、配置、文档和截图，不含 `node_modules`、`out`、`release`、`test-results` 与 `*.tsbuildinfo`）。

根目录与构建配置：

- `package.json`、`package-lock.json`、`electron.vite.config.ts`
- `electron-builder.yml`、`playwright.config.ts`、`vitest.config.ts`
- `tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`
- `.gitignore`、`.prettierrc.json`、`.prettierignore`、`LICENSE`
- `README.md`、`AGENTS.md`
- `build/icon.ico`、`build/icon.png`
- `resources/icon.png`、`resources/tray.png`
- `scripts/generate-icons.py`、`scripts/verify-packaged.cjs`

共享领域：

- `src/shared/types.ts`、`constants.ts`、`domain.ts`、`validation.ts`、`ipc.ts`

主进程：

- `src/main/index.ts`、`ipc.ts`、`window-state.ts`
- `src/main/lib/errors.ts`、`time.ts`、`user-data.ts`
- `src/main/storage/store.ts`
- `src/main/notifications/scheduler.ts`
- `src/main/integrations/import.ts`、`sync.ts`、`snapshot.ts`、`ai.ts`
- `src/main/portal/security.ts`、`service.ts`

预加载与渲染器：

- `src/preload/index.ts`、`index.d.ts`
- `src/renderer/index.html`
- `src/renderer/src/main.tsx`、`App.tsx`、`styles.css`
- `components/Modal.tsx`、`ToastStack.tsx`、`ConfirmDialog.tsx`
- `components/TaskEditor.tsx`、`TaskDetail.tsx`、`CourseDetail.tsx`
- `pages/Dashboard.tsx`、`Study.tsx`、`Courses.tsx`、`Tasks.tsx`
- `pages/Calendar.tsx`、`Questions.tsx`、`Portal.tsx`、`Settings.tsx`
- `lib/format.ts`

测试：

- `tests/unit/domain.test.ts`、`storage.test.ts`、`scheduler.test.ts`、`import.test.ts`
- `tests/unit/security.test.ts`、`sync.test.ts`、`snapshot.test.ts`、`ai.test.ts`、`user-data.test.ts`
- `tests/e2e/app.spec.ts`、`features.spec.ts`、`portal.spec.ts`、`responsive.spec.ts`、`views.spec.ts`
- `tests/fixtures/portal-test.crt`、`portal-test.key`

文档与截图：

- `docs/research.md`、`ARCHITECTURE.md`、`TEST_REPORT.md`、`ROADMAP.md`
- `docs/OPTIMIZATION.md`、`DELIVERY.md`、`ISSUES.md`
- `docs/CHAOXING_INTEGRATION_FEASIBILITY.md`、`WINDOWS_NOTIFICATIONS.md`
- `docs/screenshots/` 下 9 张浅色/深色与学习中心/题目助手截图

## 5. 启动与安装

```powershell
cd D:\Documents\deepseek-harness\default-workspace\studynext
npm install
$env:ELECTRON_RUN_AS_NODE = $null
npm run dev
```

生产构建：

```powershell
npm run build
npm run build:win
```

安装包：`release/StudyNext-Setup-0.3.0.exe`。也可直接运行 `release/win-unpacked/StudyNext.exe`。

如果终端预设了 `ELECTRON_RUN_AS_NODE=1`，启动 GUI 前必须清除。自动化环境可设置：

```powershell
$env:STUDYNEXT_DATA_DIR = "D:\StudyNextData"
```

## 6. 验证结果

- TypeScript 严格检查：通过。
- Vitest：9 个文件、47 项全部通过。
- Playwright E2E：5 个规格文件、6 项测试全部通过（应用主流程、学习中心/题库/快照与 SSO、Portal 隔离与脱敏日志、响应式、视图截图）。
- 应用主流程：无账号启动、5 门课程、15 项任务、CRUD、重启持久化、渲染进程隔离。
- 学习中心/题库：15 章节、60 学习点、学习点完成、题目卡 CRUD、JSON 快照导入。
- Portal：真实 `WebContentsView` 内 `require/process/module/window.studynext/window.ipcRenderer` 全部不可见，白名单外跳转被拦截，外部 URL 的 query 不进入公开状态/日志。
- 响应式：1080×700 下 8 个主要页面无横向溢出。
- 视觉：浅色/深色全部主要视图截图通过目检。
- 生产构建：通过（main 135.12 kB、preload 5.83 kB、renderer JS 920.50 kB、CSS 67.98 kB）。
- Windows 安装包：`release/StudyNext-Setup-0.3.0.exe`，125,169,347 bytes，SHA-256 `FCAFEED57E798D47E94F5ECF3DDC18B46BDD7BA63AD68B07FA25BC1EBE5A54D1`。
- 打包版启动验证：通过，窗口标题 `学习总览`、版本 `0.3.0`、`packaged: true`。

详细记录见 [TEST_REPORT.md](TEST_REPORT.md)。

## 7. 尚未完成的功能

- 学习通真实账号 OAuth 与课程/作业自动同步：无公开可申请接口，保持 `not_configured`。
- 应用完全退出后的系统级 DDL 提醒：仅完成调度抽象和 Windows 方案调研，未安装计划任务或常驻服务。
- 官方页面登录状态的精确校验：当前基于官方 URL 路径的启发式判断，不是令牌验证；真实账号流程未自动化验证。
- 单双周课程、调休、节假日：月/周视图按每周固定课表展示。
- 学习快照的定时拉取/自动更新：当前只支持用户手动选择 JSON；同一快照重复导入已支持增量更新与冲突保留。
- AI 服务商模型质量、费用与数据保留策略由用户自行选择；应用不内置共享 Key，也未做自动提交。
- 安装包代码签名、自动更新、崩溃上报：未接入。
- 真实学习通账号登录 E2E：未使用真实账号；隔离层已用本地 HTTPS 域名测试证书验证。

## 8. 学习通接入的真实限制

1. `open.chaoxing.com` 当前重定向循环，`open.fanya.chaoxing.com` 落到不存在的页面，未发现面向个人开发者公开可申请的 OAuth/课程作业 API 文档。
2. 没有机构合作或正式授权时，不能假设存在稳定的课程、作业、考试、通知接口；项目不会抓包或调用私有接口。
3. 官方网页的 DOM、登录流程和风控由学习通控制，本项目只托管隔离页面，不解析或注入页面。
4. 在获得授权前，稳定的数据入口是手动任务、CSV/ICS 导入、JSON 学习快照与本地课程管理。
5. 应用中的 5 门课程、15 项任务、15 个章节、60 个学习点和通知均为明确标记的本地演示数据，不代表真实学习通同步结果。

## 9. 下一阶段任务

1. 与学校或超星确认正式开放平台/机构授权，取得 OAuth 客户端与接口文档。
2. 在主进程使用 Windows Credential Manager/DPAPI 存储令牌，设计刷新、撤销与退出清理；日志永不记录令牌。
3. 实现课程、作业、考试、通知适配器：分页、增量同步、限流、字段映射、部分成功原因。
4. 为“退出后提醒”设计可选常驻服务或 Windows 计划任务，明确权限、安装、卸载与代码签名要求。
5. 增加快照增量合并、冲突解决与来源校验；继续保留手动导入作为无 API 回退。
6. 接入代码签名、自动更新、崩溃日志脱敏与版本回滚。
7. 在干净 Windows 10/11 虚拟机执行真实登录回归清单（不收集密码/Cookie/Token），加强登录状态检测并校验 SSO 跳转。
8. 增加可访问性、键盘导航、长列表性能与真实账号授权后的端到端测试。

## 10. 仓库状态

未创建 git commit，未推送到任何远程仓库，未公开发布。所有演示数据均为本地生成，未使用真实学习通账号或凭据。
