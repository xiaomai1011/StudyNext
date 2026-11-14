# StudyNext 测试报告

- 测试日期：2026-11-14
- 平台：Windows x64，Node.js v24.19.0，npm 12.0.2
- Electron：45.3.0
- 测试命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run build:win`

## 1. 结论

| 项目                    | 结果                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| TypeScript 严格类型检查 | 通过                                                                                     |
| Vitest 单元/集成测试    | **90/90 通过**（11 个文件，含学习通 Web Session 36 项）                              |
| Playwright Electron E2E | **9/9 通过**（6 个规格：应用主流程、学习中心/题库/快照与 SSO、Portal、响应式、视图截图、学习通 UI） |
| electron-vite 生产构建  | 通过                                                                                     |
| Windows NSIS 安装包     | 通过                                                                                     |
| 打包产物启动验证        | 通过（asar 主进程、preload、renderer 均正常）                                            |
| 已知失败项              | 无                                                                                       |

### 1.1 真实账号验收（2026-11-14，用户本人操作）

- 登录态：`authenticated`，Portal 标题“个人空间”，账号显示“真实学生账号（已脱敏）”。
- 真实同步：`同步完成，13 门课程、14 项作业、15 个章节、0 场考试、21 条通知、59 个资料`，失败详情为空。
- 课程字段：课程名、教师、学期、教学班链接已归一；同一课程不同教学班分别保留，界面显示教学班标识。
- 作业字段：标题、平台状态（未交/已完成）、截止时间、详情入口已落库；已完成作业也会读取详情页截止时间。
- 章节与学习点：`course_chapters` 15 条、`study_points` 38 条（7 已完成）；学习中心显示平台进度，应用内不可修改。
- 通知与资料：`app_notices` 21 条、`materials` 59 条；通知可打开官方详情，资料可打开官方入口。
- 说明：本次为单账号、单次手动同步，不代表所有学校/账号/接口长期稳定；验收清单见 `docs/CHAOXING_PHASE3_ACCEPTANCE.md`。

## 2. 单元与集成测试

### 2.1 领域模型（`tests/unit/domain.test.ts`，7 项）

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

### 2.5 安全与同步（`tests/unit/security.test.ts`，7 项）

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

### 2.10 学习通 Web Session（`tests/unit/chaoxing.test.ts`，33 项）

- 登录态：passport 重定向判为 `logged_out`；个人空间结构判为 `authenticated`；空页面保持 `unknown`。
- 个人资料解析昵称、学校、uid、fid。
- 课程列表按 `courseId + clazzId` 去重，同一课程不同教学班分别保留。
- 隐藏域 `enc/openc/workEnc` 的 `name/value` 两种属性顺序均可解析。
- 作业列表解析标题、状态、进度、详情 URL 与外部 ID。
- 作业接口返回“没有此页面访问权限”时抛出 `SIGNATURE_INVALID`。
- 作业详情解析标题、题量、满分、作答时间区间。
- 无年份截止时间按最近未来年份补齐；非法时间返回 `null`。
- 未知平台状态保持 `unknown`，不标为未提交；“已发布”明确归为 `unknown`，不会被误判为已完成。
- 哨兵截止时间不计入逾期、不进入提醒候选。
- `upsertProviderCourse` 重复同步保留收藏等本地字段；不同教学班不互相覆盖。
- `upsertImportedTask` 外部 ID 去重、平台状态写入、作业详情 `sourceUrl` 完整落库并在重复同步时保留、截止变化检测。
- 服务状态机：`logged_out`、`authenticated → expired`、`NOT_LOGGED_IN` 记为 `not_configured` 且不清空本地数据、`BLOCKED` 提示安全验证、成功落库计数与 `lastSyncAt`。
- 数据库迁移：旧任务表升级后补齐 `source_url`、`platform_status`、`platform_status_kind` 列，旧任务默认值与数据保留。
- 记住账号密码：登录页匹配只允许官方 `passport*.chaoxing.com`；自动填充脚本正确转义引号/反斜杠并触发 `input` 事件，不提交表单。
- 课表：解析学期锚点、节次表、逐周返回的课表 JSON；同一门课跨周合并为周次区间；节次映射为起止时间。
- 考试：解析 `tr.dataTr` 的考试名称/时间/时长/状态/作答/分数/方式，空列表与缺失 ID 不报错。
- 章节：解析一级章、二级节、完成/待完成/锁定状态与总任务点进度。
- 通知：解析标题、发送者、课程、发布时间（含秒）与已读状态；无法判断保持 unknown。
- 资料：解析文件夹/文件/外链、名称、类型、大小与官方链接。
- 作业提交结果：解析提交时间、得分/满分与教师批语；批语截断到 300 字并剔除题目正文。

真实账号验收：用户本人已在 Portal 登录，真实会话检查返回 `authenticated`（真实学生账号，已脱敏）。最新一次真实同步得到 13 门课程、14 项作业、15 个章节、0 场考试、21 条通知、59 个资料；短期缓存重复调用 3ms 返回缓存提示；课程详情页“同步此课程”单课程重试 11.9 秒完成。验收记录见 `docs/CHAOXING_PHASE3_ACCEPTANCE.md`。

### 2.11 资料下载与内嵌作业页（真实验证）

- `材料《【2025年秋季】第1章 劳动与人（第1讲）.pptx》` 经 `materials.download` 下载成功：`28,411,295` 字节，`state=completed`，保存到 `D:\Downloads\StudyNext\`，文件头 `50 4B 03 04`（ZIP/PPTX 签名）。
- 修复前 `downloadData` 返回 15 字节“无效的参数”，根因是把 `courseId:clazzId` 整体当作 `courseId`；现取冒号前的课程 ID。
- 内嵌官方作业页可加载到 `mooc-ans/mooc2/work/dowork`，页面含富文本编辑区、“暂时保存”“提交”按钮；应用不自动点击保存或提交。
- 下载管理器支持列表、进度、打开、定位、取消、清空；`will-download` 不再被拒绝。
- 下载 URL 只接受学习通官方 HTTPS 域名，拒绝 userinfo 与非 443 端口；重定向后的最终 URL 同样校验。
- 下载目录支持设置持久化，默认回退系统下载目录下 `StudyNext`；并发下载使用文件名预留避免重名覆盖。
- 下载历史持久化到 SQLite，重启后遗留 `progressing` 记录标记为 `interrupted`，已完成记录保留。
- 作业草稿：在实验4 内嵌页通过 UEditor API 写入测试文本，点击“暂时保存”并重载后内容保留；随后改为空白占位并再次保存，页面确认无可见测试文本。平台拒绝完全空内容，因此保留 `<p>&nbsp;</p>` 占位。
- 附件上传：程序化 `input.click()` 返回 Chromium 警告 `File chooser dialog can only be shown with a user activation.`；用 CDP `Runtime.evaluate` 的 `userGesture: true` 点击 `input[type=file]` 收到 `Page.fileChooserOpened`（`mode: selectMultiple`，`backendNodeId=11`），证明真实用户点击会打开系统文件选择器。随后用 `DOM.setFileInputFiles` 注入 56 字节测试文件，真实上传 POST `upload-ans/ueditorupload/attachment` 返回 200，附件以 `attach-iframe` 插入；点击“暂时保存”并重载后附件仍在，之后已清理测试附件。

### 2.12 作业附件、提交检测与流式下载（2026-11-14 真实验证）

- 附件解析：14 项作业中有 6 项解析出 `attachments`（AI大模型体验、学生实习资料汇总、实验1/2/3、就业岗位调研、实验4、第一章作业等），字段为 `name/size/objectId`；未知大小保持 null。
- 附件上传：56 字节 `StudyNext-附件上传验证.txt` 经官方 WebUploader 上传成功，POST `https://mooc1.chaoxing.com/upload-ans/ueditorupload/attachment?...` 返回 HTTP 200，`objectid=df27ab47eac9fc4e34067e114909748a`；保存后重新进入实验4 页面仍保留，已清理。
- 草稿：实验4 `answerId=55650091` 的 UEditor 内容经 `暂时保存` 后重载保留；完全空内容会被平台拒绝（`无效的参数：code-1`），最终以 `<p>&nbsp;</p>` 占位恢复空白。
- 提交检测：导航到 `/mooc-ans/mooc2/work/prompt?...courseId=267068456...` 时，`onSubmitDetected` 收到 `{platformCourseId:'267068456', detectedAt:'2026-11-14T12:29:12.162Z'}`；应用自动调用单课程重试并得到 `课程重试完成：程序设计基础，6 项作业、0 个章节、15 个资料`，`lastSyncAt` 更新为 `2026-11-14T12:29:24.988Z`。本轮未自动点击最终提交，真实提交由用户本人确认。
- 流式下载：28,411,295 字节 PPTX 用时 2.879 秒完成（`receivedBytes=totalBytes=28411295`，文件头 `50 4B 03 04`）；572,261,733 字节 `Dataset.zip` 用时 85.5 秒完成。取消测试在接收 19,271,680 字节后标记 `interrupted`，临时文件已删除；应用在下载中重启后记录恢复为 `interrupted`，恢复逻辑清理临时文件。
- 下载失败恢复：冷启动后先点击资料下载会预热 Portal 登录分区；PPTX 下载在接收 14,941,600 字节后取消并标记 `interrupted`，调用 `retryDownload` 后新记录重新推进到 16,376,340 字节，证明“重试”可用；重试结束后再次取消并清理临时文件。
- 安全校验：下载初始 URL 仅允许学习通官方 HTTPS，`userinfo`、非 443 端口拒绝；CDN 重定向仅允许 `cldisk.com` 及其子域，Cookie 仍按学习通域作用域发送，Referer 固定为 `pan-yz.chaoxing.com`。

### 2.13 v0.4.0 RC 收尾验证（2026-11-14）

- 附件上传事件：真实上传 46 字节测试文件时，主窗口收到 `started`（`statusCode=null`）和 `completed`（`statusCode=200`）两种 `PortalUploadEvent`；上传条在官方页面顶部显示，成功/失败状态自动消失。测试附件已从编辑器删除并保存，原附件 `20262302431041-钟嘉杨-实验4.docx` 保留。
- 上传错误分类：新增 `describeUploadCompletion`/`describeUploadError` 单元测试，覆盖 2xx/3xx 成功、4xx/5xx 失败、无响应状态和网络错误原因。
- 单条下载历史删除：删除 `c59dc55c-6532-4057-8484-8c94edf36101` 与 `49d01d32-49b5-4f44-a3f1-4fca163c9721` 两条历史后，`downloads` 数量为 22，已删除记录不再返回；`D:\Downloads\StudyNext\【2025年秋季】第1章 劳动与人（第1讲） (5).pptx` 仍为 28,411,295 字节，历史删除未触碰实际文件。
- Portal 页面恢复：同步前位于 `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork`，执行一次完整真实同步后 URL 仍为同一地址，`detail=null`，同步消息为 `同步完成，13 门课程、14 项作业、15 个章节、0 场考试、21 条通知、59 个资料`；说明同步导航守卫恢复了用户原页面。同步期间检测到用户鼠标/键盘操作时，守卫会放弃恢复并提示。
- 资料分页夹具：`parseMaterialList` 新增多页合并、重复 externalId 去重、截断 HTML 保留已解析条目、空页返回空数组的测试；真实账号没有第二页，未声称通过真实多页验证。
- 全量验证：`npm run typecheck` 通过；`npm test -- --run` **90/90 通过**（11 文件）；`npm run build` 通过；`npm run test:e2e` **9/9 通过**。

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

### 3.6 学习通 UI（`tests/e2e/chaoxing-ui.spec.ts`）

- 课程中心显示同名课程的教学班标识；课程详情展示教学班；日历周视图显示真实节次。
- 任务中心显示“同步 N 项 · 显示 M 项 · 其中逾期 K 项”；新建逾期任务后总数和其中逾期同时增加，任务行保持可见。
- 设置页密码显示/隐藏切换可用，输入值不被日志或快照记录。

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
