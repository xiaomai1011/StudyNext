# 学习通参考项目源码审查（v0.4.0）

- 日期：2026-11-12
- 审查人：StudyNext 开发组
- 范围：五个公开参考项目的只读源码审查
- 目的：为“用户本人 Web 登录会话只读同步”路线提供协议、字段与工程约束依据
- 说明：以下结论来自源码阅读与本地固定 HTML 夹具，不代表超星官方授权，也不代表接口长期稳定

## 1. 结论摘要

1. 学习通网页端确实存在课程、作业、考试、章节、通知、课表和资料数据，但这些数据通过网页接口 + 登录 Cookie + 页面上下文签名（`enc`/`openc`/`workEnc`/`stuenc`）提供，不是公开 API。
2. 三条硬约束决定接入方式：
   - 必须在已登录的同一 `persist:studynext-portal` 会话中请求；
   - 作业列表需要课程页的 `enc/openc/workEnc` 与 `stuenc`，不能手拼；
   - 跨域 iframe 与 Referer/上下文校验会让“直接 GET 接口”返回“没有此页面访问权限”。
3. 五个项目中，只有 `xuexitong-cli` 覆盖了完整的数据面；`chaoxing-mcp` 提供最小 HTTP 验证；`xuexitong-cli-skill` 提供浏览器会话与 iframe 操作约束；`chaoxing-list` 提供任务分类与截止兜底；`study_assistant` 提供本地优先数据管理参考。
4. 本轮只采纳“只读、用户手动触发、主进程发起、低并发”的部分。登录密码、明文 Cookie、自动答题、提交、签到、刷课、考试作答均不采纳。
5. 许可证：MIT（A/B/C/E）可用于参考与必要时的代码复用；D 为 AGPL-3.0-or-later，只参考功能结构，不复制代码。

## 2. 参考项目 A：xuexitong-cli（主参考）

| 项           | 内容                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 仓库         | `https://github.com/DanMo661/xuexitong-cli`                                      |
| 许可证       | MIT，Copyright (c) 2026 Wu Jiale                                                  |
| 本地副本     | `.tmp-research/xuexitong-cli`                                                    |
| 审查 commit  | `74b843ad4a3439a6ee5ba33f6a3288d9be6ed990`                                       |
| 关键文件     | `xuexitong_mcp/client.py`（1086 行）、`xuexitong_mcp/server.py`、`tests/`、`pyproject.toml` |
| 认证方式     | 手机号 + 密码，AES-CBC 加密后 POST `passport2.chaoxing.com/fanyalogin`，Cookie 明文落盘 |

### 2.1 会话与登录

- `URL_LOGIN=https://passport2.chaoxing.com/fanyalogin`，表单字段 `fid=-1, uname=AES(phone), password=AES(pwd), refer, t=true, forbidotherlogin=0, validate='', doubleFactorLogin=0, independentId=0`。
- AES key 与 IV 均为 `u2oh6Vu^HWe4_AES`，PKCS7 + base64；响应 JSON `status === true` 视为登录成功。
- 登录态检查：GET `https://i.chaoxing.com/base`，若被重定向到 `passport2` 或页面含“用户登录”则视为登出。
- **不采纳**：协议登录、明文 `session_cookies.json`，以及把账号密码交给第三方 CLI。StudyNext 只复用 Portal 中用户本人建立的会话；可选的“记住账号密码”仅在本机用 DPAPI 加密，并只填充官方登录页。

### 2.2 课程列表

- `URL_COURSELIST=https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata`，GET 参数 `courseType=1&courseFid=<fid>&courseTeacherid=0&courseOrderBy=0`。
- `parse_courses(html)` 用正则 `stucoursemiddle\?courseid=(\d+)&clazzid=(\d+)&cpi=(\d+)` 去重；课程名取 `course-name[^>]*title="..."`；教师取 `p.line2 color3` 的 `title`，兜底 `p.overHidden2`。
- 课程唯一键必须是 `courseId + clazzId`（同一门课可有多个教学班），`cpi` 作为上下文参数。
- 课程列表页也可从 `i.chaoxing.com/base` 直接解析；`fid` 从页面 `"fid":数字` 或 `var fid = '数字'` 读取，默认 427。

### 2.3 课程上下文与作业

- `URL_STUMIDDLE=https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=&clazzid=&cpi=&ismooc2=1&v=2`，响应中读取隐藏域 `enc`、`openc`、`workEnc`。
- `URL_WORKLIST=https://mooc1.chaoxing.com/mooc2/work/list`，参数 `courseId, classId, cpi, ut:s, openc, enc:workEnc, t:ms, stuenc:page_enc, isdisplaytable:2`。
- 作业列表 DOM：`<li onclick="goTask(this);" data="...">`、`<p class="overHidden2 fl">标题</p>`、`<p class="status fl">状态</p>`；`data` 需 URL 解码。
- 若页面出现“没有此页面访问权限”，说明 `enc` 或上下文失效，需重新从课程页取签名，不能重试同一 URL。
- 作业进度：`<span>已完成/总数</span>`。
- 作业详情：`parse_homework_detail()` 去标签后解析标题（“作业详情”与“题量”之间）、题量、满分、`作答时间: MM-DD HH:MM 至 MM-DD HH:MM`、得分。截止时间无年份，用“离当前时间最近的年份”补齐，跨年时不会算到一年后。
- `fetch_deadline_overview` 只对未完成作业取详情；详情失败保留 `deadline=None`，不丢弃整条作业；错误按课程记录，区分“真没作业”和“读取失败”。

### 2.4 其他数据

- 章节：`https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse`，参数 `courseid/clazzid/cpi/enc/openc/fromMiddle=1/ut/t`；进度正则 `已完成任务点:\s*<span[^>]*>(\d+)</span>/(\d+)`。
- 考试：`https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist`，解析 `tr.dataTr` 的 9 列表格。
- 通知：POST `https://notice.chaoxing.com/pc/notice/getNoticeList`，JSON 响应 `{status,notices:{list,lastGetId,lastPage}}`；`isread` 为 `'0'/'1'` 字符串；列表 `content` 即全文；最多约 100 条。
- 课表：POST `https://kb.chaoxing.com/pc/curriculum/getMyLessons`，`data.curriculum + data.lessonArray`；不带 `week` 只返回当前周，全学期需逐周合并。
- 资料：GET `.../coursedata/stu-datalist`，正则 `toOpen('name','type',data_id,'enc',...)`。
- 风控：检测 9010/antispider 页面，遇到验证码要求人工处理；巡检默认 30 分钟一轮、全量每天不超过 2 次。

### 2.5 采纳与不采纳

采纳：

- 课程 `courseId + clazzId` 复合键、`cpi` 上下文；
- 作业列表与详情解析、无年份截止时间补齐、未知截止保留任务；
- “签名失效不重试、回到课程页重新取签名”的失败语义；
- 低并发、逐课串行、失败隔离。

不采纳：

- 账号密码登录、AES 登录参数、明文 Cookie 文件；
- 自动重登录（会话失效时直接提示用户）；
- 提交作业、签到、刷课、考试作答等任何写操作。

## 3. 参考项目 B：chaoxing-mcp（次级 HTTP 参考）

| 项         | 内容                                              |
| ---------- | ------------------------------------------------- |
| 仓库       | `https://github.com/Han-maker-wp/chaoxing-mcp`    |
| 许可证     | MIT                                               |
| 审查文件   | `server.py`（393 行）                             |
| 存储       | 明文 `cookies.json`、`enc_map.json`（不采纳）      |

要点：

- `logged_in(s)`：GET `https://i.chaoxing.com/base`，最终 URL 不含 `passport2` 即视为已登录。
- 课程列表 POST `https://mooc1-1.chaoxing.com/visit/courselistdata`，表单 `courseType=1, courseFolderId=0, courseFolderSize=-1, digest=_all`；按 `<li class="course ` 分块解析 `courseId/clazzId/personId/title`。
- 作业 GET `https://mooc1.chaoxing.com/mooc2/work/list?courseId=&classId=&cpi=&ut=s&stuenc=&enc=`；`stuenc/work_enc` 必须来自浏览器页面，值对“课程 + 学生”稳定。
- 解析 `<li data="...work/task..." aria-label="标题;状态">`，剩余时间正则 `剩余[\d小时天分钟]+`，`workId/answerId` 从 URL 取。
- 工程提示：`mooc1-1` 首连可能被 RST，需要一次重试；`requests` 设置 `trust_env=False` 避免系统代理干扰。

采纳：登录态判定以最终 URL 为准；作业 URL 的 `workId/answerId` 解析；课程列表 POST 表单结构（仅作为备选，不默认使用）。

不采纳：明文 Cookie/`enc_map` 存储、无页面上下文的直连调用。

## 4. 参考项目 C：xuexitong-cli-skill（浏览器会话参考）

| 项         | 内容                                                            |
| ---------- | --------------------------------------------------------------- |
| 仓库       | `https://github.com/Han-maker-wp/xuexitong-cli-skill`           |
| 许可证     | MIT                                                             |
| 审查文件   | `skills/xuexitong/references/{login-and-nav,browser-adapters,info,homework,download,pitfalls,tasks}.md`、`skills/cli-xuexitong/SKILL.md` |

关键约束：

- 已登录页面停在 `i.chaoxing.com/base`，标题“个人空间”，存在 `#frame_content` iframe；未登录重定向 `passport2.chaoxing.com/login`。
- 课程列表位于跨域 iframe（`https://<xxx>.mh.chaoxing.com/?s=<s>&space_token=...`），只能从 iframe `src` 取 `s` 参数，再进入 `mooc1-1.chaoxing.com/visit/interaction?s=<s>`。
- 课程页子 iframe：`#frame_content-hd` 活动、`#frame_content-zy` 作业、`#frame_content-zl` 资料、`#frame_content-zj` 章节；**不能直接 goto 子 iframe URL**，会报“无权限的操作!”；必须在父页面上下文中加载。
- `enc` 是完整签名，不能截断或手工拼接；`s` 参数会过期。
- 登录必须由用户手动完成；出现验证码/滑块立即转人工，不实现加密协议登录。
- 只读范围：课程入口、作业/考试/通知/进度查询；排除自动答题、上传、提交、签到、刷课。

采纳：会话健康检查以真实受保护页面为准；课程页作为签名来源；作业请求必须带 Referer/页面上下文；不绕过验证码与风控。

## 5. 参考项目 D：chaoxing-list（功能结构参考，AGPL）

| 项       | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 仓库     | `https://github.com/Cooanyh/chaoxing-list`                           |
| 许可证   | AGPL-3.0-or-later                                                    |
| 审查文件 | `chaoxing-list.user.js`（7214 行）                                   |
| 使用方式 | 只参考功能结构、字段、任务分类、缓存与错误回退；**不复制代码**        |

可借鉴的结构：

- 任务分类：核心任务（作业、视频任务点、AI 实践、任务引擎、分组讨论、分组任务、测验、随堂练习、考试）与其他任务（签到、问卷、抢答、通知、投票、直播、评分、拍照、笔记）。
- 截止时间兜底顺序：`endTimeTimestamp → deadlineAt → deadline → endTime → timeRange → timeLeft`；支持“剩余 X 天/小时/分钟”。
- 本地缓存 TTL 5 分钟；截止提醒每 30 秒检查；忽略规则与动态规则。
- 任务字段：`type/courseId/clazzId/title/status/endTime/deadlineAt/endTimeTimestamp/timeRange/timeLeft/finished/expired/completionRate/totalTasks/isComplete`。

不采纳：AGPL 代码、页面内注入脚本、活动签到类逻辑。

## 6. 参考项目 E：study_assistant（本地数据管理参考）

| 项       | 内容                                                          |
| -------- | ------------------------------------------------------------- |
| 仓库     | `https://github.com/mshzy/study_assistant`                    |
| 许可证   | MIT                                                           |
| 技术栈   | Flutter                                                       |
| 审查文件 | `models/assignment.dart`、`services/chaoxing_*`、`local/secure_session_store.dart`、`reminder_rule_store.dart` |

可借鉴：

- 任务模型字段：`id/courseName/title/deadlineAt/requirementsText/status/submitUrl/completedAt/lastSyncedAt`。
- 默认提醒偏移 `[1440, 180, 30]` 分钟，去重降序后持久化。
- 本地优先：先落本地库，再按同步状态更新；失败保留旧数据。

反面教材：

- `statusFromChaoxing` 对未知状态默认 `pending`（StudyNext 要求 `unknown` 不得标成未提交）。
- 使用 `flutter_secure_storage` 保存学习通账号密码（StudyNext 不以明文保存；可选 DPAPI 加密记忆仅用于官方登录页填充）。

## 7. 协议与工程约束汇总

| 约束           | 结论                                                                 |
| -------------- | -------------------------------------------------------------------- |
| 会话来源       | 只能使用 `persist:studynext-portal`，由用户本人在 Portal 登录         |
| 请求发起方     | Electron 主进程；renderer 不接触 Cookie/Token                         |
| 登录态判定     | 必须请求受保护资源（如 `/base`）并解析页面结构，不能只看 URL          |
| 课程键         | `courseId + clazzId`；`cpi` 参与请求                                  |
| 作业签名       | `enc/openc/workEnc/stuenc` 来自课程页；失效时回课程页重新获取         |
| 截止时间       | 详情页可能无年份；解析失败保留任务并标记“截止时间待确认”              |
| 请求频率       | 串行、课程间 ≥120ms、手动触发、失败不自动重试                         |
| 风控           | 出现 9010/验证码/安全验证页面立即停止并提示用户本人处理                |
| 写操作         | 不做提交、答题、签到、刷课、上传、考试作答                            |
| 数据来源       | `source='chaoxing'`，与 `demo/import/manual` 严格区分                  |
| 失败语义       | 单课失败记入 `errors`，不丢弃其他课程结果；本地旧数据保持不变          |

## 8. 许可证与复用边界

- A、B、C、E 为 MIT：可以复用代码，但本轮仅参考实现，未直接复制源文件。
- D 为 AGPL-3.0-or-later：只参考功能结构与字段命名，未复制任何代码。
- 所有参考项目都不是超星官方项目；其可用性不代表平台许可或接口稳定性。

## 9. 复现与证据

- 本地副本：`.tmp-research/xuexitong-cli`、`.tmp-research/chaoxing-mcp`、`.tmp-research/xuexitong-cli-skill`、`.tmp-research/chaoxing-list`、`.tmp-research/study_assistant`
- 固定 HTML 夹具与解析测试：`tests/unit/chaoxing.test.ts`
- 适配器实现：`src/main/integrations/chaoxing/{parsers,session-client,adapter,service}.ts`

## 10. 变更记录

| 日期       | 变更                                                         |
| ---------- | ------------------------------------------------------------ |
| 2026-11-12 | 建立五项目源码审查基线；明确采纳/不采纳边界与三项硬约束      |
