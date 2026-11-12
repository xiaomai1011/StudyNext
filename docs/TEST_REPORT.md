# StudyNext 测试报告

- 测试日期：2026-11-12
- 平台：Windows x64，Node.js v24.19.0，npm 12.0.2
- Electron：45.3.0
- 测试命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run build:win`

## 1. 结论

| 项目                    | 结果                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| TypeScript 严格类型检查 | 通过                                                                                     |
| Vitest 单元/集成测试    | **47/47 通过**（9 个文件）                                                               |
| Playwright Electron E2E | **6/6 通过**（5 个规格：应用主流程、学习中心/题库/快照与 SSO、Portal、响应式、视图截图） |
| electron-vite 生产构建  | 通过                                                                                     |
| Windows NSIS 安装包     | 通过                                                                                     |
| 打包产物启动验证        | 通过（asar 主进程、preload、renderer 均正常）                                            |
| 已知失败项              | 无                                                                                       |

## 2. 单元与集成测试

### 2.1 领域模型（`tests/unit/domain.test.ts`，6 项）

- DDL 升序排序，同一截止时间按优先级排序。
- 逾期、今天、三天内、以后、已完成分组。
- 关键词、课程、状态、优先级组合筛选。
- 待办、逾期、今日截止与完成率统计。
- 提醒偏移去重、取整、越界过滤与倒序。
- 跨天剩余时间的中文紧凑文案。

### 2.2 提醒调度（`tests/unit/scheduler.test.ts`，6 项）

- 在正确的提前时间点生成候选；已完成任务不再提醒。
- 超出补发窗口的旧提醒不会突然弹出。
- 正确返回下一条未来提醒时间。
- 启动补发只执行一次，同一到期提醒不会重复投递。
- 通知失败释放投递占位，后续 tick 仍可重试。
- 预设与自定义提醒时长的中文文案。

### 2.3 数据存储（`tests/unit/storage.test.ts`，9 项）

- 首次启动写入 5 门课程、15 项任务、15 个章节与 60 个学习点。
- 任务新增、读取、修改、完成、删除闭环。
- 修改截止时间清理旧投递记录，新 DDL 可重新提醒。
- 相同任务、规则、截止时间只投递一次。
- 课程收藏与设置写入数据库。
- 关闭并重新打开数据库后数据仍然存在。
- 从 v2 schema 迁移到 v3：补齐任务字段与变更日志，保留旧任务。
- 一键恢复演示数据会清理手工数据并重建种子。
- 增量导入按外部 ID 更新，截止变化计数，手动字段冲突保留且本地完成不被覆盖。

### 2.4 导入（`tests/unit/import.test.ts`，5 项）

- CSV 中英文字段、优先级、类型与提醒时长解析。
- CSV 缺少标题或截止时间返回致命错误。
- CSV 自动创建课程、写入任务并按 `externalId` 去重。
- ICS 的 TZID、全天事件与折叠行解析。
- 导入失败返回 failure，不虚报成功。

### 2.5 安全与同步（`tests/unit/security.test.ts`，6 项）

- 仅允许学习通官方域名及其子域的 HTTPS 页面。
- 拒绝带 userinfo 的官方 URL，避免用户名/密码样式地址绕过。
- 网页视图关闭 Node、开启沙箱、使用独立持久化会话。
- 展示 URL 去除 query 与 hash，避免泄露令牌。
- 未配置授权适配器时固定返回 `not_configured`。
- 适配器失败时返回 failure，本地数据保持不变。

### 2.6 授权适配器状态机与快照来源（`tests/unit/sync.test.ts`，4 项）

- 未配置时 `not_configured`，`lastSuccessAt` 为 null。
- 配置后 pull 失败返回 failure，任务数量不变。
- 配置后 pull 成功导入任务并返回 success。
- 导入本地快照后来源为 `import`，状态文案明确说明不是实时学习通同步。

### 2.7 学习快照（`tests/unit/snapshot.test.ts`，4 项）

- 解析根对象与 `data` 包装，导入课程、章节、学习点、作业和考试。
- 不同课程可使用相同章节/学习点外部 ID，按课程作用域去重。
- 嵌套与顶层任务不会重复导入；任务 ID 带课程前缀避免冲突。
- 进度支持 `0.5` 小数与 `"25%"` 百分比；非法 JSON 返回结构化失败。

### 2.8 AI 解题助手（`tests/unit/ai.test.ts`，3 项）

- Base URL 仅接受 HTTPS；localhost HTTP 作为本地模型例外。
- 提示词包含题目与上下文，但不包含 API Key。
- 解析 OpenAI 兼容响应的正文、模型和错误结构。

### 2.9 数据目录解析（`tests/unit/user-data.test.ts`，4 项）

- Windows 候选顺序为 `LOCALAPPDATA\StudyNext`、应用数据目录。
- `STUDYNEXT_DATA_DIR` 覆盖候选且不读取其他路径。
- 返回第一个可创建目录；文件占用路径会抛出明确错误。
- 候选路径中绝不回退到系统临时目录。

## 3. Electron E2E

### 3.1 应用主流程（`tests/e2e/app.spec.ts`）

- 无学习通账号直接启动，无登录阻断。
- 首页显示 5 门课程、演示通知与任务统计。
- `window.studynext` 可用，但 `ipcRenderer`、`require` 不可见。
- 任务中心初始 15 项；依次完成新建、编辑、完成、删除。
- 关闭并重新启动 Electron 后，新增任务仍存在（16 项）。
- 打开设置页并确认页面标题。

### 3.2 学习中心与题库（`tests/e2e/features.spec.ts`）

- 学习中心显示 5 门课程、15 个章节、60 个学习点。
- 完成一个学习点后，章节/课程进度更新。
- 新建题目卡并使用搜索/课程筛选。
- 通过文件选择导入 JSON 学习快照，断言导入统计、课程/章节/学习点可见。
- 标题栏显示“本地快照 · 非实时同步”，不会冒充学习通实时数据。
- 校园 SSO 域名设置保存后重载仍然保留，空值/非法域名由 Zod 校验拒绝。

### 3.3 Portal 隔离（`tests/e2e/portal.spec.ts`）

使用本地 HTTPS 服务和测试证书模拟 `test.chaoxing.com`，在真实 `WebContentsView` 中加载页面：

- 页面标题正确加载为 `Portal Isolation Probe`。
- 页面上下文中 `require`、`process`、`module`、`window.studynext`、`window.electron`、`window.ipcRenderer` 全部为 `undefined`。
- 执行跳转到 `https://example.com/blocked` 后，Portal 状态变为 `blocked`，视图 URL 没有离开学习通白名单。
- 入口 URL 带 `?token=e2e-secret#section` 时，对外 state 与导航日志均不含 token；导航日志只保留脱敏 URL 与拦截原因。

### 3.4 响应式（`tests/e2e/responsive.spec.ts`）

窗口 1080×700 下依次打开总览、学习中心、课程中心、任务中心、日历、题目助手、官方页面、设置，断言主滚动容器无横向溢出。

### 3.5 视图完整性（`tests/e2e/views.spec.ts`）

浅色与深色主题下渲染全部主要视图，等待 `page-in` 动画结束后截图，标题与关键区域均有断言。日历视图额外验证月/周视图切换，并点击日历任务打开详情弹窗。

产物：

- `docs/screenshots/dashboard-light.png`
- `docs/screenshots/courses-light.png`
- `docs/screenshots/tasks-light.png`
- `docs/screenshots/calendar-light.png`
- `docs/screenshots/study-light.png`
- `docs/screenshots/questions-light.png`
- `docs/screenshots/portal-light.png`
- `docs/screenshots/settings-light.png`
- `docs/screenshots/dashboard-dark.png`

## 4. 构建与打包

- `npm run build`：主进程、preload、renderer 三端构建通过。
- `npm run build:win`：生成 `release/StudyNext-Setup-0.3.0.exe`（125,169,347 bytes，约 119.37 MiB）。
- SHA-256：`FCAFEED57E798D47E94F5ECF3DDC18B46BDD7BA63AD68B07FA25BC1EBE5A54D1`。
- `scripts/verify-packaged.cjs`：以 Playwright 启动 `release/win-unpacked/StudyNext.exe`，断言窗口标题 `学习总览`、版本 `0.3.0` 与 `packaged: true`。
- 安装包未代码签名。

## 5. 测试环境说明

- E2E 使用工作区内独立的 `STUDYNEXT_DATA_DIR` 与 `--user-data-dir`，不读写真实用户数据库，也不会污染用户配置。
- 自动化宿主对 Electron 子进程的 AppData/Temp 写入有限制，因此测试显式指定隔离目录；这属于测试宿主约束，不影响正常桌面安装运行。
- E2E 启动参数包含 `--no-sandbox --disable-gpu`；正式应用仍启用 Chromium/Electron 沙箱，Portal 的 `sandbox` 与 `contextIsolation` 始终为 true。
- 系统代理可能破坏 `--host-resolver-rules`，Portal E2E 显式使用 `--no-proxy-server`。

## 6. 验收对照

| #   | 验收要求                        | 结果                                                            |
| --- | ------------------------------- | --------------------------------------------------------------- |
| 1   | 无学习通账号可启动              | 通过：E2E 无登录步骤直接进入主界面                              |
| 2   | 首页完整显示模拟数据            | 通过：5 门课程、通知、统计、今日待办                            |
| 3   | 任务新增、编辑、完成、删除      | 通过：E2E 全流程                                                |
| 4   | 重启后数据一致                  | 通过：E2E 关闭并重启后断言                                      |
| 5   | DDL 按剩余时间正确排序          | 通过：单元测试                                                  |
| 6   | 修改截止时间后提醒正确更新      | 通过：旧投递清理 + 重算测试                                     |
| 7   | 相同任务不产生重复通知          | 通过：claim/去重测试                                            |
| 8   | 权限或网络失败不显示同步成功    | 通过：`not_configured` / failure 状态测试                       |
| 9   | 第三方网页无法访问 Electron API | 通过：真实 WebContentsView 内探针全部 undefined，越界跳转被拦截 |
| 10  | 能生成 Windows 安装产物         | 通过：NSIS 安装包与打包版启动验证                               |
