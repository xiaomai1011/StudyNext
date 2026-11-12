# 学习通数据接入能力矩阵（v0.4.0）

- 版本：0.4.0 开发基线
- 日期：2026-11-12
- 适用范围：StudyNext C 路线（Electron 桌面客户端 + 隔离 Portal + 可插拔 Provider）
- 结论：官方 API 授权仍未获证实；本轮已实现“用户本人 Web Session”的课程、作业与 DDL、课表、考试、章节、通知、资料同步，以及资料下载、下载管理器和内嵌官方页面的编辑/附件/草稿/提交入口。平台写操作只通过用户本人正常登录的内嵌官方页面完成，应用不伪造提交或进度。

## 1. 判定图例

| 标记                 | 含义                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `官方授权可用`       | 已有可核验的官方 OAuth/API 文档、scope、测试环境，并且 StudyNext 已完成接入验证。当前没有一项达到此状态。                                       |
| `机构授权后可用`     | 技术上可通过学校/超星机构合作获得，但尚未取得书面授权、接口文档或测试账号，不能写成已实现。                                                     |
| `Web Session 只读`   | 用户本人在隔离 Portal 登录学习通后，主进程复用同一持久会话，低频只读解析本人数据。已实现代码与模拟测试；真实账号验证由用户本人完成。              |
| `Web Session 可操作` | 在隔离 `WebContentsView` 内由用户本人执行平台原生操作（编辑、上传、草稿、提交），或由主进程复用同一会话流式下载本人有权访问的资料；应用不伪造状态。 |
| `用户手动导入`       | 用户主动提供 JSON 快照、CSV 或 ICS；导入后在本机使用，不冒充实时同步。                                                                           |
| `仅官方页面可访问`   | 只能在隔离的 `WebContentsView` 中由用户本人查看；不抓取、不解析页面内容作为同步结果。                                                             |
| `暂时不可实现`       | 目前既没有授权接口，也没有可靠的用户导出方式；不以网页抓取替代。                                                                                 |

## 2. 能力矩阵

| #   | 能力         | v0.4.0 当前判定   | 目标           | 当前实现/证据                                          | 说明                                                                                   |
| --- | ------------ | ----------------- | -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | 课程列表     | Web Session 只读  | 机构授权后可用 | `ChaoxingSessionAdapter.pull()` + `parseCourseList`     | 读取 `/base` 课程卡片；归一 courseId/clazzId/cpi/courseName/teacher/courseUrl            |
| 2   | 课程详情     | 用户手动导入      | 机构授权后可用 | 快照课程字段 + 官方页面                                | Web Session 只取课程卡片字段；教学大纲、学分、班级详情未解析                            |
| 3   | 作业列表     | Web Session 只读  | 机构授权后可用 | `mooc2/work/list` + `parseHomeworkList`                | 依赖课程页 `enc/openc/workEnc` 与 `stuenc`；单课失败隔离                                |
| 4   | 作业截止时间 | Web Session 只读  | 机构授权后可用 | 作业详情页 `resolveDeadline`                           | 支持有年份与无年份格式；解析失败保留任务并显示“截止时间待确认”                           |
| 5   | 作业提交状态 | Web Session 只读  | 机构授权后可用 | `platformStatus` / `platformStatusKind`                | 读取平台状态文本；已完成/已提交/待批阅/已评分→done，未提交/待完成→pending；“已发布”等其余文本→unknown |
| 6   | 考试列表     | Web Session 只读  | 机构授权后可用 | `exam-ans/exam/test/examcode/examlist` + `parseExamList` | 只读列表与官方入口；不进入作答页、不读取答案；考试状态与作业状态分离 |
| 7   | 考试时间     | Web Session 只读  | 机构授权后可用 | 考试列表“考试时间”列 + `parseExamDate` | 解析开始/结束时间、时长；无数据时显示空态，不伪造考场/座位 |
| 8   | 课程公告     | 仅官方页面可访问  | 机构授权后可用 | Portal 课程页 | 无公告模型、全文同步或已读状态 |
| 9   | 学校通知     | Web Session 只读  | 机构授权后可用 | `notice.chaoxing.com/pc/notice/getNoticeList` + `parseNoticeList` | 标题/来源/课程/发布时间/摘要/已读状态；无法判定时保持 unknown，不默认未读 |
| 10  | 章节目录     | Web Session 只读  | 机构授权后可用 | 课程页“章节” iframe + `parseChapterList` | 读取真实章节树；需先点击课程页“章节”导航生成同域 iframe |
| 11  | 学习点       | Web Session 只读  | 机构授权后可用 | `parseChapterList` + `upsertSnapshotPoint(...,'chaoxing')` | 任务点类型/完成状态/已完成数；平台进度只读，应用内不可修改 |
| 12  | 学习进度     | Web Session 只读  | 机构授权后可用 | 章节“已完成任务点 n/total” + 学习中心 | 平台统计与本地手动状态分离；不写回学习通 |
| 13  | 课件和资料   | Web Session 可操作 | 机构授权后可用 | 课程页“资料” iframe + `parseMaterialList` + `downloadData` | 文件夹/文件/外链、名称/类型/大小、官方入口；主进程复用同一会话下载到 `Downloads\StudyNext`，支持进度、取消、打开与定位 |
| 14  | 课程课表     | Web Session 只读  | 机构授权后可用 | `kb.chaoxing.com/pc/curriculum/getMyLessons`（Portal 同源逐周）+ `schedule.ts` | 逐周 1..maxWeek 拉取并按课程/星期/节次/地点聚合；semesterStart、maxWeek 落库；跨教学班重复节次界面去重 |
| 15  | 作业编辑与提交 | Web Session 可操作 | 机构授权后可用 | 隔离 `WebContentsView` 内官方作业页 | 用户本人编辑、上传附件、暂时保存、确认后提交；应用不代填、不代提交、不伪造状态 |
| 16  | 提交结果/成绩/批语 | 仅官方页面可访问 | 机构授权后可用 | 官方作业详情页 | 当前未建立原生模型与同步；不推测未返回的分数或批语 |

## 3. 逐项结论

### 3.1 本轮已实现：Web Session 只读

已实现并通过模拟测试：

- 登录状态检查：请求 `https://i.chaoxing.com/base`，解析个人空间结构，区分 `unknown / logged_out / authenticated / expired`。
- 个人资料健康检查：读取非敏感字段（昵称、学校、uid、fid），不显示密码、Cookie、Token。
- 课程列表：解析课程卡片，按 `courseId + clazzId` 去重；同一课程不同教学班分别保留。
- 作业列表：从课程页读取 `enc/openc/workEnc`，携带课程上下文与 Referer 请求 `mooc2/work/list`；解析标题、状态、进度、详情 URL，并把详情 URL 写入 `tasks.source_url`，任务详情可打开原页。
- 作业截止时间：逐份读取未完成作业详情，解析“作答时间”区间；无年份时按最近未来年份补齐。
- 作业状态：平台状态文本与本地 `status` 分离；未知状态保持 `unknown`，不强制标为未提交。
- 课表：在 Portal 课表页内用同源 `fetch` 逐周拉取 `getMyLessons`，按课程/星期/节次/地点聚合，写回 `courses.schedule_json` 与 `semester_start/max_week`；日历与首页按周次过滤。
- 考试列表：读取 `examlist` 的考试名称/时间/时长/状态/作答状态/分数/方式/官方入口；只读列表，不进入作答页、不读取或提交答案。
- 章节目录与学习点：点击课程页“章节”导航，在生成的同域 iframe 中解析章节树、任务点类型、完成状态与“已完成任务点 n/total”；学习点标记 `source='chaoxing'`，应用内不可修改平台进度。
- 通知：Portal 通知页内同源请求 `getNoticeList`，解析标题/来源/课程/发布时间/摘要/已读状态；无法判定已读时保持 `unknown`。
- 资料：点击课程页“资料”导航，解析文件夹/文件/外链、名称/类型/大小与官方打开入口；不默认批量下载。
- 同步反馈：主进程逐阶段推送 `SyncProgressEvent`（课程/作业/课表/考试/章节/通知/资料），设置页显示当前资源与计数，可请求取消同步。
- 落库：`source='chaoxing'`；外部 ID 去重、截止变化检测、手动字段保护、变更历史、失败保留旧数据。

边界与限制：

- 真实账号已由用户本人验证（2026-11-12）：`authenticated`，13 门课程、13 项作业、课表均有周次/节次/地点；登录过期或换号后需重新检查。
- 网页结构、`enc` 签名和字段名可能变化；解析失败会显示 `partial/failure`，不会伪造成功。
- 登录失效（`expired`）时停止自动请求，提示用户重新登录。
- 遇 9010、验证码、安全验证或限流页面立即停止，转人工处理。

### 3.2 仍然只能手动导入的能力

- 课程详情（大纲、学分、班级完整信息）
- 需要机构授权的成绩、学分等学籍类字段
- 资料下载与批量导出（本轮只做列表与官方入口）

导入结果必须标记 `source='import'`，显示导入时间与文件名，不能冒充实时同步。

### 3.3 只能通过官方页面访问的能力

- 课程公告全文
- 资料下载、在线预览等需要平台内交互的动作
- 需要登录后才可见的课程页面内容

StudyNext 只提供隔离的官方页面入口；同步所需的课程/章节/资料读取在 Portal 已登录页面内由主进程受控执行，不向远程页面注入 preload、Node 或任意脚本。

### 3.4 需要正式授权后才能设计的能力

- 官方 OAuth / 机构 API 的增量游标与分页
- Token 刷新、撤销和机构审计
- 服务端推送或变更订阅
- 任何 SLA、限流承诺与数据授权证明

## 4. Provider 能力声明

Provider 不应通过“是否能打开网页”判断能力，而应显式声明：

```ts
type AccessLevel = 'official' | 'institutional' | 'web_session' | 'manual' | 'web_only' | 'unavailable'

interface ProviderCapabilities {
  courses: AccessLevel
  courseDetail: AccessLevel
  homework: AccessLevel
  homeworkDeadline: AccessLevel
  submissionStatus: AccessLevel
  exams: AccessLevel
  examSchedule: AccessLevel
  courseAnnouncements: AccessLevel
  schoolNotices: AccessLevel
  chapters: AccessLevel
  studyPoints: AccessLevel
  progress: AccessLevel
  materials: AccessLevel
  schedule: AccessLevel
}
```

约束：

- `official` 只能在有文档、scope、测试账号和成功回归后设置。
- `institutional` 只能在书面授权和接口文档到位后设置。
- `web_session` 表示“用户本人会话只读”，必须在 UI 显示连接方式为 Web Session，不能写成官方授权。
- `manual` 由用户主动导入触发，不产生“自动同步”状态。
- `web_only` 只能打开官方页面，不能把页面内容转成领域对象。
- `unavailable` 必须显示“暂不可用”，不能伪造空成功。

## 5. 认证与同步状态语义

认证状态：

| 状态            | 触发条件                                                     | UI 必须显示             |
| --------------- | ------------------------------------------------------------ | ----------------------- |
| `unknown`       | 尚未检查，或网络/解析异常无法判定                             | 未检查 / 无法确认       |
| `logged_out`    | `/base` 重定向到 passport2，或页面出现登录表单                | 未登录，请先在 Portal 登录 |
| `authenticated` | `/base` 返回个人空间结构，受保护资源读取成功                  | 已登录（Web Session）   |
| `expired`       | 上次为 `authenticated`，本次变为登出                          | 登录已过期，请重新登录   |

同步状态：

| 状态               | 触发条件                         | UI 必须显示                       |
| ------------------ | -------------------------------- | --------------------------------- |
| `not_configured`   | 没有 Provider 会话或没有手动导入 | 未配置/本地模式，不得显示“已连接” |
| `syncing`          | 正在读取已授权数据源             | 进度与当前资源                    |
| `success`          | 所有请求资源成功，且结果已落库   | 成功数量、时间、来源              |
| `partial`          | 部分课程/作业成功、部分失败      | 成功/失败资源、错误摘要、可重试项 |
| `failure`          | 关键请求失败或登录失效           | 错误摘要、本地数据未受影响        |

## 6. 不能标记为可用的项目

- 官方 OAuth / 机构 API 授权（未获证实）
- 自动登录、验证码识别/绕过、MFA 绕过
- 自动刷课、伪造学习记录
- 自动考试答题、代交作业
- 把官方页面打开成功当成数据同步成功
- 用第三方项目（包括 xuexitong-cli）替代官方授权证明
- 将模拟通知或演示课程显示成真实学习通数据

## 7. 验收口径

v0.4.0 验收同时看两条线：

1. 手动导入能稳定更新课程/章节/学习点/任务，并正确标记来源。
2. Web Session 同步必须先通过“检查登录状态”，再允许“仅同步学习通”；未认证时同步按钮禁用。
3. 同步中心显示连接方式、最近检查/同步时间、课程/作业计数、失败原因，不显示 Cookie/Token/完整敏感 URL。
4. 官方页面入口保持隔离，危险导航被拦截，日志脱敏。
5. 任何页面打开成功都不会增加“同步成功”计数。
6. 真实账号验证结果由用户本人执行并记录；没有真实账号时只能标记为“模拟测试通过”。

## 8. 变更记录

| 日期       | 变更                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 2026-11-12 | 建立能力矩阵基线：官方授权未获证实，能力以手动导入与官方页面为主                         |
| 2026-11-12 | 新增 `Web Session 只读` 级别；课程列表、作业列表、截止时间、提交状态改为已实现（模拟测试） |
| 2026-11-12 | 课表改为 Web Session 只读；Portal 同源逐周读取 `getMyLessons`，semesterStart/maxWeek/schedule 落库；真实账号 13 门课程/13 项作业/课表已验证 |
