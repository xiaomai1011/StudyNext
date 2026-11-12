# 学习通真实数据接入研究报告（v0.4.0）

- 版本：0.4.0 研究基线
- 调研日期：2026-11-12
- 项目：StudyNext
- 结论等级：研究结论 + 本轮 Web Session 只读实现记录；不等于平台授权，也不等于官方 API 接入
- 相关文档：`docs/CHAOXING_ACCESS_MATRIX.md`、`docs/CHAOXING_REPO_REVIEW.md`、`docs/V0.4.0_GO_NO_GO.md`

## 1. 结论摘要

1. 截至调研日，公开网络中没有找到超星学习通面向个人开发者的开放平台注册入口、OAuth scope 列表、课程/作业/考试数据 API 文档和公开申请流程。
2. `open.chaoxing.com` 与 `open.fanya.chaoxing.com` 目前不能作为公开开发者文档站点使用；前者最终跳转到登录页，后者落到“不存在”的机构页面。
3. 登录页出现的 `auth.chaoxing.com/connect/oauth2/authorize` 是登录联盟/第三方登录链路的一部分，不能据此推断存在课程数据授权 API。
4. 学校机构授权在现实中可能存在，但必须通过超星或学校的正式合作、应用登记、接口文档、测试账号和数据协议确认。公开网页无法证明某所学校已经获得这些权限。
5. v0.4.0 采用双路线，并在 UI 与文档中明确区分：
   - **官方 API 授权路线**：仍未获得公开可核验的 OAuth/机构接口，不假设其存在，也不把它作为本轮前置条件。
   - **用户身份认证路线（本轮实现）**：用户本人在隔离 Portal 中正常登录学习通，主进程复用同一 `persist:studynext-portal` 持久会话，发起低频、只读请求。已实现登录状态检查、个人资料健康检查、课程列表、作业列表、截止时间、作业状态与提交状态文本；考试、课表、章节、学习点、通知、资料仍未实现。
6. 该路线不绕过验证码、MFA、风控、反爬或限流；账号密码默认不进入应用。用户可选启用“记住账号密码”，由 Windows DPAPI 加密保存在本机，仅注入官方 passport 登录页做自动填充，不自动提交、不上传；Cookie/Token 不落业务数据库、不进入 renderer、不写日志。它仍然依赖网页接口与 HTML 结构，属于“用户知情后使用的兼容层”，不能宣传为官方稳定 API。
7. `xuexitong-cli`（MIT）具有很高的数据模型参考价值，但它依赖网页登录 Cookie、隐藏表单字段和 HTML 解析，不能被视为官方 API。本轮只参考其协议与解析逻辑，不复用其账号密码登录与明文 Cookie 存储。

## 2. 调研方法与证据边界

调研使用了以下方法：

- 直接请求并记录超星开放平台相关 URL 的 HTTP 状态、最终地址和页面标题。
- 检查登录页中出现的 OAuth/第三方登录链接，区分“身份登录”与“课程数据授权”。
- 检索公开代码托管平台，确认是否存在可核验的官方 SDK、OAuth 文档或机构接入说明。
- 只读审查 `xuexitong-cli` 的 README、MIT LICENSE、`xuexitong_mcp/client.py` 和 `xuexitong_mcp/server.py`。
- 对照 StudyNext 现有的快照导入、CSV/ICS 导入和 Portal 隔离能力，形成能力矩阵。

证据边界：

- “没有找到”只表示在本次公开调研范围内没有找到，不等于断言超星永远不提供机构接口。
- 机构合作通常不是公开网页行为，必须由学校信息化部门或超星销售/实施团队提供书面材料。
- 未使用真实学生账号进行登录或数据抓取；没有收集、保存或输出任何密码、Cookie、Token。
- 本文档不把登录页、网页接口、第三方项目的能力写成“已授权可用”。

## 3. 官方开放平台核实

### 3.1 直接访问记录

| 请求地址                                             | 最终结果（2026-11-12）                                                                    | 判断                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `https://open.chaoxing.com/`                         | 200，最终落到 `passport2.chaoxing.com/login`，`refer` 指向 `open.chaoxing.com/op/toindex` | 需要登录，未展示公开开发者文档         |
| `https://open.chaoxing.com/oauth`                    | 同上                                                                                      | 没有公开 OAuth 应用注册页或 scope 文档 |
| `https://open.fanya.chaoxing.com/`                   | 200，最终落到 `super.fy.chaoxing.com/views/nonexistent.html?t=nounit3...`                 | 机构不存在/未开通页面，不是开放平台    |
| `https://open.fanya.chaoxing.com/oauth`              | 同上                                                                                      | 同上                                   |
| `https://auth.chaoxing.com/connect/oauth2/authorize` | 200，页面标题仅为 `Oauth`，没有可用文档                                                   | 不能据此认定课程数据 API 存在          |

### 3.2 能确认与不能确认的内容

能确认：

- 超星存在统一登录、机构站点和第三方登录链路。
- 学习通的网页端自身会调用课程、作业、考试、通知等网页接口。
- 这些网页接口需要登录态、机构上下文、课程 `enc/openc` 等参数，且页面结构可能变化。

不能确认：

- 是否存在面向个人开发者的 OAuth 申请。
- 是否存在公开的课程/作业/考试数据 scope。
- 是否允许第三方桌面客户端长期保存 Token 并同步数据。
- 机构授权的合同模板、接口清单、调用频率、数据保留要求。
- 任何“个人开发者可以自助申请”的说法。

因此，任何把 `auth.chaoxing.com` 登录跳转解释为“已获得课程数据授权”的说法都不成立。

## 4. 学校/机构授权可行性

机构授权是当前唯一可信的实时接入路径，但不能仅凭“学校买了学习通”推导出“学校允许第三方客户端读取数据”。正式接入至少需要以下材料：

1. 学校信息化部门或超星出具的接入许可/合作说明。
2. 应用登记信息：应用名称、开发者主体、回调地址、联系人、用途。
3. OAuth 或等价的认证方式、client id/secret 的保管方案。
4. 明确的数据 scope：课程、章节、作业、考试、通知、课表、资料等分别是否开放。
5. 接口文档、字段字典、分页/增量规则、错误码和限流规则。
6. 测试学校、测试账号和验收环境。
7. 个人信息保护影响评估、数据保留期限、删除机制和日志脱敏要求。
8. 生产环境变更和故障支持联系人。

在这些材料到位前，产品只能使用用户主动导入的数据，或让用户在隔离的官方页面中自行查看。

## 5. 现有导出与快照能力

StudyNext 当前已经具备：

- JSON 学习快照导入：课程、章节、学习点、作业、考试和课表；同一外部 ID 支持更新、截止时间变化检测和手动字段保护。
- CSV/ICS 导入：适合任务和日程的稳定离线补充。
- 官方页面兼容视图：使用 `WebContentsView`、独立持久会话、URL 白名单、危险跳转拦截和脱敏导航日志。
- 本地任务完成状态与平台完成状态分离；导入数据标记为 `import`，不伪装成实时同步。

当前快照不包含或不能可靠表达：

- 作业提交状态、得分、教师批语。
- 课程公告和学校通知的全文/已读状态。
- 课件和资料文件列表及下载权限。
- 平台侧真实学习进度、视频观看进度和任务点完成来源。
- 增量游标；当前是“再次导入并比对”，不是服务端增量同步。

## 6. xuexitong-cli 只读研究

### 6.1 基本信息

| 项           | 内容                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 仓库         | `https://github.com/DanMo661/xuexitong-cli`                                      |
| 许可证       | MIT License，Copyright (c) 2026 Wu Jiale                                         |
| 本地只读副本 | `.tmp-research/xuexitong-cli`                                                    |
| 审查 commit  | `74b843ad4a3439a6ee5ba33f6a3288d9be6ed990`                                       |
| 代码规模     | `xuexitong_mcp/client.py` 约 1087 行；`server.py` 约 498 行                      |
| 依赖         | `mcp>=1.2.0`、`requests>=2.28`、`pycryptodome>=3.19`；桌面助手部分另有 Qt 等依赖 |
| 定位         | CLI + MCP Server + 桌面助手，宣称只读查询                                        |
| 是否官方     | 否；没有超星官方授权或 SDK 证据                                                  |

### 6.2 与需求相关的工具

`server.py` 中可核对的 16 个工具包括：

- `login`、`get_profile`
- `get_schedule`、`export_schedule_ics`
- `list_courses`
- `list_materials`、`find_materials`、`download_material`
- `list_homework`、`get_homework_detail`、`get_homework_deadlines`
- `get_progress_overview`
- `list_exams`
- `list_chapters`
- `list_notices`
- `list_pan_files`

其中用户指定的七个核心能力对应关系如下：

| 能力     | 工具                     | 主要数据                     | 备注                         |
| -------- | ------------------------ | ---------------------------- | ---------------------------- |
| 课程列表 | `list_courses`           | 课程名、课程 ID、班级上下文  | 网页课程列表解析             |
| 作业列表 | `list_homework`          | 作业标题、提交状态、完成进度 | 依赖课程上下文               |
| 作业截止 | `get_homework_deadlines` | 截止时间、未交排序           | 需要逐份详情页，请求次数较多 |
| 章节目录 | `list_chapters`          | 章节树、任务点完成标记       | 依赖网页课程页               |
| 考试列表 | `list_exams`             | 考试名称、时间、状态         | 网页考试列表解析             |
| 通知     | `list_notices`           | 通知标题、正文、游标         | 网页通知接口                 |
| 课表     | `get_schedule`           | 周次、星期、节次、地点、教师 | 需要周参数和学期配置         |

其他工具还覆盖资料下载、任务点概览、个人资料和 ICS 导出。

### 6.3 实现方式和只读边界

只读审查确认：

- 认证依赖用户登录后的 Cookie/会话；登录参数在客户端侧做网页表单所需的加密。
- 数据读取依赖超星网页接口、HTML 解析、隐藏 `enc/openc`/`workEnc` 等字段。
- `download_material` 只把资料文件流式写入用户指定的本地目录，没有发现提交作业、签到、刷课或考试作答调用。
- 验证码处理是让用户手动输入，不是自动绕过。
- 代码没有超星官方 SDK 或 OAuth client 的迹象。

因此它适合作为“字段模型、请求顺序、网页结构变化、只读边界”的研究材料，不适合直接嵌入 StudyNext：

- 网页登录会接触用户密码和 Cookie，安全责任高。
- HTML/隐藏字段解析很脆弱，服务端改版就会失效。
- 频繁轮询可能触发风控；项目自己也建议温和频率。
- MIT 许可证允许复用代码，但本项目不复制其源文件；本轮以独立实现提供“用户本人会话只读兼容层”，并在文档与 UI 中明确它依赖可能变化的网页结构，不是官方 API。

### 6.4 技术价值与风险结论

技术价值：

- 验证了学习通网页侧确实存在可读取的课程、作业、考试、章节、通知、课表和资料数据。
- 提供了领域模型参考：课程上下文、作业截止、任务点、通知游标、课表周次。
- 提供了“只读、不提交”的产品边界样例。

主要风险：

- 不是官方 API，随时可能变更。
- 需要保存高敏感登录态。
- 可能违反平台条款或学校管理要求（本报告只做技术风险评估，不把风险描述成已获许可）。
- 无法提供稳定的 SLA、限流承诺或数据授权证明。
- 不能把它的成功调用当作 StudyNext 可以上线实时同步的依据。

## 7. StudyNext 的接入路线与实现边界

### 7.1 两条路线必须分开命名

| 路线           | 含义                                                         | 本轮状态                       |
| -------------- | ------------------------------------------------------------ | ------------------------------ |
| 官方 API 授权  | OAuth、机构合作、官方接口、书面 scope 与限流承诺              | 未获证实，不假设存在           |
| 用户身份认证   | 用户本人登录学习通，复用其真实 Web 会话读取自己的课程数据     | 已实现 Phase 1–3 的只读部分    |

`authState='authenticated'` 只表示“用当前会话访问受保护资源成功”，不表示 OAuth 授权成功。UI 必须显示“连接方式：Web Session”，不能显示“官方授权已连接”。

### 7.2 本轮已实现：Portal Web Session 只读

实现位置：

- `src/main/integrations/chaoxing/parsers.ts`：登录态、个人资料、课程列表、作业列表/详情、隐藏域、截止时间解析。
- `src/main/integrations/chaoxing/session-client.ts`：`PortalSessionHttpClient`，优先 `session.fetch`（`credentials:'include'`），失败回退 `net.request({session, useSessionCookies:true})`；请求前做 URL 白名单校验，只统计 Cookie 域数量，不读取值。
- `src/main/integrations/chaoxing/adapter.ts`：`ChaoxingSessionAdapter.checkSession()` 与 `pull()`；课程间 120ms 间隔，单课失败隔离。
- `src/main/integrations/chaoxing/service.ts`：`ChaoxingSessionService`，串行锁、状态机、落库与状态持久化。
- `src/main/ipc.ts` / `src/preload/index.ts`：`chaoxing:status`、`chaoxing:check`、`chaoxing:sync` 三个通道。
- `src/renderer/src/pages/Settings.tsx`：连接状态卡、最近检查/同步、课程/作业计数、手动按钮。

数据流：

```text
用户在 Portal 手动登录
  -> 主进程 session.fromPartition('persist:studynext-portal')
  -> GET https://i.chaoxing.com/base（受保护页面，验证登录态）
  -> 解析个人资料 + 课程列表（courseId + clazzId + cpi）
  -> 逐课 GET 课程页，读取隐藏域 enc / openc / workEnc
  -> GET mooc2/work/list（带课程上下文与 Referer）
  -> 解析作业列表；对未完成作业 GET 详情，解析截止时间
  -> Provider -> Normalizer -> SyncService -> SQLite（source='chaoxing'）
```

已实现的归一字段：

- 课程：`courseId`、`clazzId`、`cpi`、`courseName`、`teacher`、`courseUrl`；外部键 `courseId:clazzId`，同一课程不同教学班不会互相覆盖。
- 作业：`externalId`（课程键 + workId/标题哈希）、`title`、`courseExternalId`、`dueAt`、`platformStatus`、`platformStatusKind`、详情 URL。
- 截止时间解析失败时保留任务，`dueAt` 使用哨兵 `2099-12-31T15:59:59.000Z`，UI 显示“截止时间待确认”，日历与提醒跳过该任务；未知状态保持 `unknown`，不强制标为未提交。

认证状态机：

| 状态            | 触发条件                                                     |
| --------------- | ------------------------------------------------------------ |
| `unknown`       | 尚未检查，或网络/解析异常无法判定                             |
| `logged_out`    | `/base` 被重定向到 passport2，或页面出现登录表单              |
| `authenticated` | `/base` 返回个人空间结构（账号 aria-label、个人资料字段）     |
| `expired`       | 上次为 `authenticated`，本次检查变为登出                      |

同步状态仍复用 `not_configured / syncing / success / partial / failure`；`partial` 表示部分课程或部分作业详情失败，已成功的部分照常落库。

### 7.3 Electron 会话复用的验证结论

- `session.fromPartition('persist:studynext-portal')` 与 Portal 的 `WebContentsView` 使用同一持久分区，主进程可以取得同一份 Cookie 存储。
- `session.fetch` 必须显式 `credentials:'include'`；不能假设默认行为一定带 Cookie。
- `net.request` 作为兜底，关键是同时传 `session` 与 `useSessionCookies: true`；只传 `session` 不保证带上 Cookie。
- 不同 `chaoxing.com` 子域的 Cookie 作用域由 Chromium 管理，主进程不手工拼 Cookie，也不把 Cookie 复制到 `defaultSession`。
- 代码路径与模拟测试已通过；**真实账号登录态验证必须由用户本人执行**，本轮不宣称真实接入已成功。

### 7.4 尚未实现的能力

按顺序后续实现，每项单独解析、测试、更新能力矩阵：

1. 课表（`kb.chaoxing.com/pc/curriculum/getMyLessons`）。
2. 考试列表（`mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist`）。
3. 章节目录（`mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse`）。
4. 学习点与进度（章节树 + 任务点计数）。
5. 通知（`notice.chaoxing.com/pc/notice/getNoticeList`）。
6. 资料列表（`.../coursedata/stu-datalist`）。

### 7.5 真实账号验证步骤（PoC 手册）

本轮没有可用的真实学生账号，以下步骤必须由用户本人在本机执行，结果记入验收记录：

1. 启动应用（开发模式 `npm run dev`，或使用已构建版本），进入“学习通”页面。
2. 在隔离 Portal 中打开 `https://i.chaoxing.com/base`，由用户本人完成账号登录、验证码或 MFA；应用不接触密码。
3. 确认 Portal 显示个人空间后，回到“设置 → 学习通与同步”，点击“检查登录状态”。
4. 预期结果：
   - 状态显示“已登录（Web Session）”；
   - 连接方式显示 Web Session，传输方式显示 `session.fetch`（失败回退时显示 `net.request`）；
   - 显示非敏感昵称/学校，最近检查时间更新；
   - 若显示“未登录”或“登录已过期”，重新在 Portal 登录后再检查。
5. 点击“仅同步学习通”，观察进度与结果：
   - 成功时显示已同步课程数、作业数、最近同步时间；
   - 部分失败时显示 `partial` 与错误摘要，已成功数据仍落库；
   - 出现“需要安全验证”时立即停止，由用户在 Portal 手动处理，不重复请求。
6. 在“任务”页确认作业标题、课程归属、截止时间；未知截止显示“截止时间待确认”，不进入日历和提醒。
7. 在任务详情点击“打开学习通原页”，确认作业详情 URL 已完整落库并可打开。
8. 找到平台显示“已发布”的作业，确认本地完成状态保持未知/未完成，不得显示“已完成”。
9. 验收记录至少包含：日期、登录状态、课程数、作业数、`partial` 错误、传输方式、应用版本。**不要记录 Cookie、Token、完整请求 URL 或账号密码。**

逐项验收表见 `docs/CHAOXING_PHASE3_ACCEPTANCE.md`。真实账号验证通过前，所有“已实现”结论仅代表代码完成 + 模拟测试通过。

### 7.6 明确不做

- 不实现验证码绕过、MFA 绕过、反爬规避、自动重登录。
- 不实现提交作业、自动答题、签到、刷课、伪造学习记录、考试作答。
- 不把官方页面打开成功标记为数据同步成功。
- 不把模拟通知、演示课程或导入快照写成“已连接学习通”。
- 不做任意 URL 抓取工具；所有请求只允许白名单学习通域名与已验证只读路径。
- 不在高频轮询下运行；第一阶段只提供用户手动触发的同步。

## 8. 待向超星/学校确认的问题清单

1. 是否提供面向第三方桌面应用的 OAuth 2.0 或等价授权？
2. 个人开发者是否可以申请；若不可以，学校机构如何登记应用？
3. 课程、章节、作业、考试、通知、课表、资料分别对应哪些 scope？
4. 是否提供 sandbox、测试学校、测试账号和回调地址白名单？
5. 数据更新频率、增量字段、分页上限和限流错误码是什么？
6. Token 有效期、刷新机制、撤销机制和审计要求是什么？
7. 是否允许本地缓存课程内容和作业标题；保留多久？
8. 发生数据冲突时以平台还是用户手动编辑为准？
9. 是否有品牌、UI 和“第三方客户端”展示规范？
10. 出现接口变更时的通知周期和技术支持渠道是什么？

## 9. 证据与复现

本次调研的可复现命令：

```powershell
curl.exe -sS -L --max-time 30 -o NUL -w "%{http_code}|%{url_effective}|%{content_type}" https://open.chaoxing.com/
curl.exe -sS -L --max-time 30 -o NUL -w "%{http_code}|%{url_effective}|%{content_type}" https://open.fanya.chaoxing.com/
curl.exe -sS -L --max-time 30 -o NUL -w "%{http_code}|%{url_effective}|%{content_type}" https://auth.chaoxing.com/connect/oauth2/authorize
```

本地只读材料：

- `.tmp-research/xuexitong-cli/LICENSE`
- `.tmp-research/xuexitong-cli/README.md`
- `.tmp-research/xuexitong-cli/xuexitong_mcp/client.py`
- `.tmp-research/xuexitong-cli/xuexitong_mcp/server.py`
- `.tmp-research/chaoxing-open-login.html`
- `.tmp-research/chaoxing-auth.html`

## 10. 变更记录

| 日期       | 变更                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-12 | 建立 v0.4.0 真实接入研究基线；记录官方入口探测、xuexitong-cli 只读审查和接入门槛                                             |
| 2026-11-12 | 修订为双路线：保留官方 API 授权结论，新增“用户本人 Web Session 只读”实现记录、认证状态机、已实现字段与未实现能力清单          |
