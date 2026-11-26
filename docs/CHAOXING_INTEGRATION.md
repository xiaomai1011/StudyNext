# StudyNext 学习通集成

> 本文合并原 `CHAOXING_ACCESS_MATRIX.md`、`CHAOXING_INTEGRATION_FEASIBILITY.md`、`CHAOXING_INTEGRATION_RESEARCH.md`、`CHAOXING_PHASE3_ACCEPTANCE.md`、`CHAOXING_ASSIGNMENT_EDITOR_RESEARCH.md` 与 `CHAOXING_REPO_REVIEW.md` 的长期有效结论。
> 结论日期：2026-11-25。事实以当前源码与最近一次真实账号验证为准；历史研究日期保留在对应结论旁。

## 1. 定位与结论

StudyNext 的学习通集成是**用户本人 Web Session 的只读兼容层**，不是学习通官方 API 客户端。

- 官方 OAuth / 机构数据接口：截至 2026-11-12 调研，没有找到面向个人开发者公开可用的注册入口、scope 清单、接口文档或申请流程；`open.chaoxing.com` / `open.fanya.chaoxing.com` 不能作为公开开发者文档站使用。
- 当前实现：用户在隔离的 `WebContentsView` 中登录学习通，主进程复用同一 `persist:studynext-portal` 会话读取本人课程、作业、考试、章节、学习点、通知、资料与课表；数据写入本地 SQLite。
- 写操作：作业编辑、附件上传、草稿保存、提交等全部在官方页面内由用户本人完成；应用只负责打开页面、监听提交结果并回读数据。
- 明确不实现：验证码/MFA 绕过、自动登录、自动刷课、伪造签到、自动答题、代交作业、反爬规避、未授权私有接口访问。

**能力声明规则：** `authState='authenticated'` 只表示“当前会话可以访问受保护页面”，不表示获得 OAuth 授权；UI 必须显示“连接方式：Web Session”，不能显示“官方授权已连接”。

## 2. 授权与合规边界

### 2.1 官方入口核实（2026-11-12）

| 地址                                                 | 观察结果                                                                           | 判断                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `https://open.chaoxing.com/`                         | 302 到 `passport2.chaoxing.com/login`，`refer` 指向 `open.chaoxing.com/op/toindex` | 需登录，无公开开发者文档                                   |
| `https://open.chaoxing.com/oauth`                    | 同上                                                                               | 无公开 OAuth 应用注册页或 scope 文档                       |
| `https://open.fanya.chaoxing.com/`                   | 落到 `super.fy.chaoxing.com/views/nonexistent.html?t=nounit3...`                   | 机构未开通页，不是开放平台                                 |
| `https://open.fanya.chaoxing.com/oauth`              | 同上                                                                               | 同上                                                       |
| `https://auth.chaoxing.com/connect/oauth2/authorize` | 200，页面标题仅 `Oauth`，无可用文档                                                | 属于登录联盟/第三方登录链路，不能据此认定课程数据 API 存在 |

机构授权路径的正式接入至少需要：学校/超星书面许可、应用登记、OAuth 或等价认证、明确数据 scope、接口文档与字段字典、测试学校/账号、个人信息保护评估、变更支持联系人。材料不到位时不得把“学校购买学习通”推导为“允许第三方客户端同步”。

### 2.2 必须遵守的产品边界

- 只读取用户本人有权访问的数据；不访问他人数据、不绕过机构权限。
- 不实现自动刷课、挂机、伪造签到、自动考试答题、监考绕过。
- 不实现验证码绕过、反爬规避、私有协议破解、未授权接口访问。
- 不把未配置、失败、部分成功描述为成功；任何“页面打开成功”都不等于同步成功。
- 远程页面中不得暴露 Node.js、文件系统、SQLite 或通用 IPC。

### 2.3 参考项目使用边界

调研审查了 `xuexitong-cli`（MIT）、`chaoxing-mcp`（MIT）、`xuexitong-cli-skill`（MIT）、`chaoxing-list`（AGPL-3.0-or-later）、`study_assistant`（MIT）。只参考协议顺序、字段模型与失败语义，不复制其账号密码登录、明文 Cookie 存储或任何写操作逻辑；AGPL 项目未复制代码。参考项目均非官方项目，其可用性不代表平台许可或接口稳定性。

## 3. 当前架构

### 3.1 会话与隔离

- Portal 使用 `session.fromPartition('persist:studynext-portal')` 的持久分区；`WebContentsView` 配置 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`，不注入 preload，不暴露 `window.studynext`。
- 只允许 HTTPS 的 `chaoxing.com` / `xuexitong.com` 及其子域；校园 SSO 必须由用户显式加入 `trustedSsoDomains`，仍要求 HTTPS、443 端口、无 userinfo、精确域名或子域匹配。
- 导航日志只记录 `safeDisplayUrl()` 处理后的地址：去掉 query、hash、userinfo；不记录 Cookie、Token、账号、密码或表单内容。
- 主进程通过 `PortalSessionHttpClient` 发请求：优先 `session.fetch`（`credentials:'include'`），失败回退 `net.request({ session, useSessionCookies: true })`；请求前做 URL 白名单校验，只统计 Cookie 域数量，不读取值。
- 不同 `chaoxing.com` 子域的 Cookie 作用域由 Chromium 管理；不手工拼 Cookie，不复制到 `defaultSession`。

### 3.2 数据流

```text
用户在 Portal 手动登录
  -> 主进程 session.fromPartition('persist:studynext-portal')
  -> GET https://i.chaoxing.com/base（受保护页面，验证登录态）
  -> 解析个人资料 + 课程列表（courseId + clazzId + cpi）
  -> 逐课 GET 课程页，读取隐藏域 enc / openc / workEnc
  -> GET mooc2/work/list（带课程上下文与 Referer）
  -> 解析作业列表；对未完成作业 GET 详情，解析截止时间
  -> Provider -> Normalizer -> SyncService.recordSessionResult() -> SQLite（source='chaoxing'）
```

关键实现：

- `src/main/integrations/chaoxing/parsers.ts`：`detectLoginState`、`parseProfile`、`parseCourseList`、`parseHomeworkList`、`parseHomeworkDetail`、`parseTaskAttachments`、`resolveDeadline`、`classifyHomeworkStatus`、`parseNoticeList`、`parseMaterialList`、`parseChapterList`、`parseKnowledgeCardResources`、`parseExamList`。
- `src/main/integrations/chaoxing/session-client.ts`：`PortalSessionHttpClient`。
- `src/main/integrations/chaoxing/adapter.ts`：`ChaoxingSessionAdapter.checkSession()` / `pull()`；课程间 120ms 间隔，单课失败隔离。
- `src/main/integrations/chaoxing/service.ts`：`ChaoxingSessionService`，串行锁、状态机、落库与状态持久化。
- `src/main/ipc.ts` / `src/preload/index.ts`：`chaoxing:status`、`chaoxing:check`、`chaoxing:sync` 等通道。
- `src/renderer/src/pages/Settings.tsx`：连接状态卡、最近检查/同步、课程/作业计数、手动按钮。

### 3.3 数据合并与字段约定

- 课程键必须为 `courseId + clazzId`；`cpi` 参与请求。同一课程不同教学班不得互相覆盖。
- 作业 `externalId` 使用“课程键 + workId/标题哈希”；重复同步更新而非新增。
- 截止时间解析失败时保留任务，`dueAt` 使用内部哨兵 `2099-12-31T15:59:59.000Z`，UI 显示“截止时间待确认”，日历与提醒跳过该任务。
- 未知平台状态保持 `unknown`，不得默认标为未提交；平台状态六态 `not_submitted / submitted / pending_review / reviewed / done / unknown`。
- 用户手动修改字段记录在 `manualFields`，后续导入保留；截止时间变化记录 `deadlineChanges` 并清理旧通知投递。
- 本地完成状态不被平台返回值覆盖；数据来源严格区分 `manual / import / chaoxing / demo`。
- 同步状态五态：`not_configured / syncing / success / partial / failure`；`partial` 表示部分课程或部分作业详情失败，已成功部分照常落库。
- `lastCompleteSyncAt` 只在完整成功时更新。

## 4. 认证状态机

| 状态            | 触发条件                                                  |
| --------------- | --------------------------------------------------------- |
| `unknown`       | 尚未检查，或网络/解析异常无法判定                         |
| `logged_out`    | `/base` 被重定向到 `passport2`，或页面出现登录表单        |
| `authenticated` | `/base` 返回个人空间结构（账号 aria-label、个人资料字段） |
| `expired`       | 上次为 `authenticated`，本次检查变为登出                  |

这是页面级启发式，不是服务端身份校验；学习通改版、跨域 SSO 或登录页嵌入方式变化都可能使状态不准确。真实账号验收必须由用户本人手动完成。

## 5. 能力矩阵

判定等级：`Web Session 只读`、`Web Session 可操作`（用户在隔离 WebContentsView 内操作或主进程同会话流式下载）、`用户手动导入`、`仅官方页面可访问`、`暂时不可实现`、`官方授权可用`（当前无一项）。

| 能力               | 当前实现方式                                                                       | 等级                           | 已知限制                                                 |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| 课程列表           | 解析 Portal 已渲染课程卡（courseId/clazzId/cpi）                                   | Web Session 只读               | 依赖页面 DOM；封面/学期/教学班字段可能不完整             |
| 作业列表           | 课程页取 `enc/openc/workEnc/stuenc`，请求 `mooc2/work/list` 并解析                 | Web Session 只读               | 隐藏签名失效需回课程页重取；页面结构可能变化             |
| 作业截止           | 逐份作业详情解析“作答时间 ... 至 ...”                                              | Web Session 只读               | 无年份需按最近年份补齐；详情失败保留任务并标记待确认     |
| 提交状态           | 列表状态 + 详情页 + 提交后事件/导航检测                                            | Web Session 只读               | 部分作业不返回提交时间；详情未完整读取保持 `unread`      |
| 考试列表           | 解析考试列表页表格                                                                 | Web Session 只读               | 无原生考试作答；状态/时间字段解析不稳定                  |
| 考试时间           | 同上                                                                               | Web Session 只读               | 平台页面结构变化会影响                                   |
| 学校通知           | `notice.chaoxing.com/pc/notice/getNoticeList`，最多约 3 页/100 条                  | Web Session 只读               | 无已读同步、分类管理或主动推送                           |
| 章节目录           | `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse`，Portal 点击“章节”后读取 | Web Session 只读               | 平台 `0/0` 任务点课程只能浏览，不显示虚构进度            |
| 学习点             | 章节页任务点标记；进度 `已完成任务点 n/total`                                      | Web Session 只读               | 依赖页面标记；无任务点课程明确提示“仅供浏览”             |
| 学习进度           | 同上                                                                               | Web Session 只读               | 不推算视频观看进度或非任务点内容                         |
| 课件资料           | `coursedata/stu-datalist` 解析资料树与文件项                                       | Web Session 只读               | 文件夹节点未完整建模；分页只做部分支持；部分大小字段为空 |
| 课程课表           | `kb.chaoxing.com/pc/curriculum/getMyLessons`，逐周合并                             | Web Session 只读               | 单双周、调休、多教师、多时段等复杂情况未完整建模         |
| 作业编辑与提交     | 隔离官方作业页；UEditor 编辑、WebUploader 上传、`addStudentWorkNewWeb` 保存/提交   | Web Session 可操作（用户本人） | 非原生编辑器/上传组件；应用不代填、不代提交              |
| 提交结果/成绩/批语 | 作业详情解析成绩、满分、教师批语、附件                                             | Web Session 只读               | 提交时间常为 null；批语可能截断；附件归属不明确          |
| 课程公告           | 仅官方页面访问                                                                     | 仅官方页面可访问               | 不转领域对象、不进入同步计数                             |
| 课程详情           | 部分字段手动导入                                                                   | 用户手动导入                   | 不冒充实时同步                                           |

## 6. 作业页面协议摘要

以下仅用于维护官方页面兼容层，不是公开 API 文档。

- 作业详情入口：`mooc1.chaoxing.com/mooc-ans/mooc2/work/task?...`，最终跳到 `dowork` 页面。
- 富文本编辑器：UEditor，textarea id 形如 `answer406079016`，iframe `#ueditor_0`；读取 `UE.getEditor(<textarea id>).getContent()`；写入 `setContent(content, false)` 后调用 `ed.sync()`。
- 附件上传：WebUploader，`input[type=file][name=file].webuploader-element-invisible`、`#pickfiles`、`#pickfiles2`；单文件上限 500MB；上传 `POST https://mooc1.chaoxing.com/upload-ans/ueditorupload/attachment?uploadtype=work&source=1&enc2=...&t=...&uid=...`；成功后插入 `<iframe class="attach-iframe" objectid="..." filename="..." filesize="...">`。
- 暂时保存：`saveWork()` POST `addStudentWorkNewWeb`，成功响应 `{"msg":"保存成功！","status":true}`。
- 提交：先 GET `/work/validate`，再 POST `addStudentWorkNewWeb`；成功且 `data.stuStatus == 5` 可跳 `data.backUrl`，否则进入 `/mooc-ans/mooc2/work/prompt?...`；空内容可能返回 `无效的参数：code-1`。
- 应用实现：附件解析、任务详情附件列表、提交检测（`addStudentWorkNewWeb` POST 与 `/work/prompt` 双路）及提交后按课程重新同步；不实现原生富文本编辑器、原生上传 UI、原生提交按钮。
- 所有操作必须在官方页面内由用户本人确认；不得把 HTTP 成功当作平台提交成功。

## 7. 资料下载

- 资料列表来自 `coursedata/stu-datalist`，下载地址来自 `coursedata/downloadData` 或页面提供的 `toOpen(...)` 参数。
- 主进程使用 Portal 会话（`session` + `useSessionCookies: true`）流式下载到 `Downloads\StudyNext`；支持进度、取消、失败重试、打开、定位、单条历史删除（不删除实际文件）。
- `downloads` 表记录 `id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id, attachment_task_id, attachment_object_id, attachment_file_name, attachment_index`；`material_local_files` 记录本地核验。
- 当前未持久化失败原因，UI 统一显示“下载失败或中断”；断点续传、批量下载全部资料、真实多页资料验证仍未完成。

## 8. 已知限制与失效语义

- 学习通页面解析依赖 DOM/HTML 与隐藏字段，平台改版可能导致部分字段失败；解析器必须保持可观测、可回退。
- `enc/openc/workEnc/stuenc` 是动态签名；失效时返回“没有此页面访问权限”，必须回课程页重新获取，不能重试同一 URL。
- 跨域 `#frame_content` iframe 可能导致外层 HTML 无法直接取课程卡；课程页子 iframe 不能直接 goto，会报“无权限的操作!”。
- 每课最多读取 20 份作业详情；作业列表分页未处理；未知截止时间用哨兵值。
- 401/403/安全验证/9010 页面必须立即停止同步并提示用户本人处理；不自动重试、不绕过。
- 真实账号验证只覆盖部分链路：登录、课程、作业、截止时间、`sourceUrl`、课表；未覆盖未登录识别、会话过期、安全验证、断网降级、真实资料分页、跨设备。
- 当前同步为用户手动触发或前端定时触发；不是后台服务，不承诺无人值守的实时性。

## 9. 真实账号验收清单

- [ ] 用户在官方登录页手动登录，应用只显示状态变化。
- [ ] 登录成功后能返回入口页，不出现白名单误拦截。
- [ ] 登录失败/取消后显示 `logged_out`，可重新尝试。
- [ ] 校园 SSO 域名只有用户显式保存后才允许导航。
- [ ] 导航日志不含 query、fragment、Cookie、Token、账号或密码。
- [ ] 关闭并重开 Portal 后会话仍由 Electron partition 管理。
- [ ] 清理会话后旧登录态不再显示为已登录。
- [ ] 无网络、DNS 失败、证书失败均显示错误而不是“同步成功”。
- [ ] 检查登录状态显示“已登录（Web Session）”与传输方式（`session.fetch` 或 `net.request`）。
- [ ] 同步成功显示课程数、作业数、最近同步时间；部分失败显示 `partial` 与错误摘要。
- [ ] 任务页作业标题、课程归属、截止时间正确；未知截止显示“截止时间待确认”，不进入日历和提醒。
- [ ] `sourceUrl` 完整落库并能在官方页面打开。
- [ ] 作业提交后自动刷新为“待审核”；成绩/批语回读正确。
- [ ] 资料下载进度、取消、重试、再次下载、本地核验可用。

验收记录至少包含：日期、登录状态、课程数、作业数、`partial` 错误、传输方式、应用版本。**不要记录 Cookie、Token、完整请求 URL 或账号密码。**

## 10. 不可声称的能力

- 没有官方 OAuth 授权，不得声称“已连接学习通官方 API”或“官方授权同步”。
- 不实现自动刷课、伪造签到、自动考试答题、验证码绕过、反爬规避。
- 不把 `xuexitong-cli` 等第三方项目的私有接口调用复制进生产代码。
- 不把本地 JSON 快照/CSV/ICS 包装成平台实时数据。
- 不保证学习通页面结构长期不变。
- 不把“页面打开成功”写成“同步成功”，不增加同步计数。

## 11. 维护规则

- 新增学习通能力必须更新本文件的能力矩阵，标明等级与限制。
- 改动解析器、会话、状态机或作业页协议时，同步更新 `src/main/integrations/chaoxing/*` 与对应单测/夹具，并记录在 [CHANGELOG.md](CHANGELOG.md)。
- 真实账号验证结果只写日期与范围，不写凭据；未验证项写入 [STATUS.md](STATUS.md)。
- 接入官方 API 前必须有合法授权文件、scope、测试账号与回归环境；不得用抓包私有接口替代。
