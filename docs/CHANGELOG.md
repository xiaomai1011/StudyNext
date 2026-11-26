# Changelog

> 本文件记录版本级变更。历史条目中的测试数字是当时基线；当前基线与测试命令见 [TESTING.md](TESTING.md)。已删除的过程报告不再链接，需要追溯请查 git 历史。

## v0.5.0 — 2026-11-18

### Windows 系统级 DDL 提醒（NEXT-01，2026-11-21）

- 新增 `StudyNext.exe --check-reminders` 无界面模式：不创建窗口/Renderer/Portal/同步，只读取当前工作区 SQLite、检查到期提醒、发送 Windows 通知并更新投递记录。
- 新增当前用户级 Windows Task Scheduler 一次性动态任务：`StudyNext-DDL-<机器名>-<SID 摘要>`，`--check-reminders` 动作，`StartWhenAvailable`，不启用 WakeToRun，不要求管理员。
- 与进程内 `ReminderScheduler` 共用 `notification_deliveries` 幂等键；通知失败释放 claim，避免伪造成功。
- 通知点击通过 `studynext://task/<taskId>` 打开 StudyNext 对应任务；设置页显示系统任务注册/下一次检查/最近检查/错误，并提供重新注册。
- NSIS 安装/卸载通过 `build/installer.nsh` 调用 `--install-reminders` / `--uninstall-reminders`；只操作当前用户任务，不删除用户数据。
- 验证：Unit 293/293、E2E 83/83、typecheck、build、build:win 通过；Windows 唯一测试任务注册/删除、dev headless 实际通知已验证。打包版计划任务注册在当前 DSH 环境受权限限制，需正常 Windows 环境复验。

### 系统级提醒可靠性修复（NEXT-01-R，2026-11-21）

- R01：新增 `notification_delivery_failures` 持久化失败队列；通知失败按 1/5/15 分钟有界退避，最多 4 次；下一次 Windows 触发取正常提醒与有效重试的最早时间，失败记录保留到真正发送成功；投递错误与计划任务错误分开保存。
- R02：通知改为 `studynext://task/<id>` 协议激活，支持进程退出后冷启动、单实例转发、Renderer 就绪握手和缺失任务降级；NSIS 安装/卸载同步注册/清理协议。
- R03：计划任务名改用当前用户 SID 的稳定摘要，principal 使用 SID 并在查询时翻译回 SID 做归属校验；旧用户名任务仅在动作、参数和 principal 归属都匹配时迁移删除。
- 验证：typecheck、Unit 309/309、E2E 84/84、build、build:win 通过；真实 Windows SID 任务注册/清理、旧任务迁移、headless 通知、headless 退出后 Action Center 实际点击激活、两个独立进程间的失败重试持久化均已验证。安装器实际安装/卸载、Task Scheduler 按重试时间真实执行、多用户环境仍未验证。

### 过期提醒重试失效（NEXT-01-R01，2026-11-22）

- 任务截止时间或提醒规则实际变化时，在 `updateTask` / `upsertImportedTask` 事务内删除该任务的过期 `notification_delivery_failures`；只改标题等无关字段时保留有效重试。
- 任务完成、删除、demo 清理同步删除失败记录；`deleteStaleDeliveryFailures` 只处理当前任务，不触碰其他任务。
- `reminderCandidateFromFailure` 在 headless 与进程内 Scheduler 中共用，投递前重新校验任务当前 `dueAt`、当前规则、重新计算的 `scheduledFor` 和 dedupe key；任何不一致都判定失效，不再使用旧记录字段。
- `notificationsRepairSystemTask` 重排时合并正常提醒与最早有效 retry。
- 验证：Unit 317/317（37 文件）、定向 39/39、E2E 84/84、typecheck 与 build 通过；未真实触发 Windows Task Scheduler 重排，安装器与真实用户提醒未操作。

### 数据安全与核心逻辑

- Checkpoint 1：DATA-003 不完整章节结果不物理删除学习点；SEC-002 保存凭据不改变当前身份，登录后校验平台 UID。
- Checkpoint 2：每账号独立 SQLite 工作区、稳定平台 UID 映射、VACUUM INTO 事务备份、实际恢复验证、A/B 数据隔离。
- Checkpoint 2-Fix：主进程真实账号切换与重启、只读历史库无副作用、迁移目标 EEXIST 拒绝覆盖、嵌套作业页切换保护；补齐旧同步/旧重试在成功、异常与 finally 各分支的代次失效，以及真实自动重启 E2E。
- Checkpoint 3：快照导入不再改写同名平台课程；无平台 ID 的同班同名作业按稳定参数区分或明确报告冲突，不再静默覆盖；成绩、批语、附件按“未读取 / 有效值 / 平台明确为空”三态更新。
- Checkpoint 3-Fix / CP3-F2：作业身份不依赖状态、成绩、列表顺序或临时签名；每次同步读取历史身份映射，落库前校验 externalId 唯一；单条候选不无依据复用旧 ID；不完整详情不凭空清空成绩、批语或附件；加载中、空占位、附件区缺失均保持 `unread`；身份异常警告优先展示。
- Checkpoint 3-Fix / CP3-F2-03-R：附件状态使用独立扫描完成证据，不再复用整页 `complete`；`aria-busy=true`、加载占位、空附件容器、附件区缺失、无完成标记一律 `unread` 并保留历史附件；只有可靠的完成证据且明确为空才 `confirmed_absent`。
- Checkpoint 4B-Fix / CP4B-01：平台任务的完成、删除和通用更新在主进程层受保护；Renderer 禁用不再是唯一防线。平台同步会清洗历史 `status` 手动保护、恢复平台状态与 `completionSource=platform`。

### 账号与登录

- 支持保存多个学习通账号；账号卡、账号菜单与应用内登录弹窗。
- 保存账号通过 DPAPI 安全存储并自动登录；首次绑定使用平台 UID 校验。
- 每账号独立 SQLite 工作区；历史归属不明时保留只读历史库，不自动认领或覆盖。
- 账号切换走主进程受控重启：检查作业编辑与上传，停止同步与调度器，写入 pending switch 后重新装载目标工作区。

### 章节、资料与界面

- 章节小节内容独立展示；无任务点课程保留章节、小节与资料，不伪造 100% 完成；任务总数只使用真实任务点。
- 章节资源解析 `knowledge/cards` 附件，支持名称、大小与内嵌打开。
- 资料中心按课程合并、去重、课程颜色；任务中心整行点击打开详情；首页周课表按五时段布局。
- 统一低饱和桌面视觉与浅色/深色主题；全局搜索 Ctrl+K 与命令面板；通知中心与课程上下文入口。
- Checkpoint 4A：课程资料筛选与返回详情恢复；课程官方页面使用当前课程 URL；命令面板章节定位；通知/考试唯一课程匹配；日历周视图课程块可点击/键盘进入；移除 portal 死路由与重复官方入口。
- Checkpoint 4A-01：章节定位请求接收后立即消费，滚动/高亮计时本地化；提前离开 Study 或连续搜索不同课程章节时不会重放旧请求或覆盖新课程。
- Checkpoint 4B：任务状态统一为平台状态、本地完成、逾期、评分四轴；逾期不再覆盖平台六态；平台任务不能被 Dashboard checkbox 本地完成；缺少 `sourceUrl` 时打开入口禁用并解释；0 分正确显示；任务中心与记录增加已提交/已批阅筛选；平台任务禁止本地删除；任务编辑器增加未保存确认。
- Checkpoint 4C：课程与全局进度只使用真实任务点；无任务点课程保留章节/小节/资料，不显示虚构 100%；章节数不再替代任务点数；多学期课表增加学期选择，周次/最大周次不再取 `courses[0]`；周课表补充非固定时段并支持同一时段多课堆叠；课程中心增加学期筛选。
- Checkpoint 4C-Fix：全部学期模式下每门课程按自己的 `semesterStart/maxWeek` 计算当前周，已结束学期不再混入当前课表；动态时间行改为按完整开始/结束时间唯一归属，重叠时段不再重复展示；Dashboard/Calendar 统一课程级学期判断。
- Checkpoint 4D：资料按 `courseId` 分组并保留教学班来源；同名但 URL 不同的资料不再合并；无平台 ID 时使用稳定 URL 哈希；`downloads.material_id` 安全迁移并关联资料；资料中心内嵌下载队列、进度/取消/重试/再次下载/打开文件/文件夹/删除记录；PDF/图片/文本应用内预览，Office/压缩包/链接明确外部打开；重启后中断下载恢复为可重试状态。
- Checkpoint 4D-Fix：再次下载与重启后重试统一从当前工作区资料重新解析下载来源，不再依赖进程内临时 URL；URL 型文件与无数字平台 ID 的资料可正常进入下载 IPC；下载入口预热改为非阻塞，离线/慢网时仍会立即创建下载记录；资料中心移除未下载条目的多余状态文本。
- Checkpoint 4E-B1：课程中心与课程详情表现层升级；课程卡移除嵌套交互，收藏与详情入口独立；课程/教学班来源、课表与五个课程上下文入口保留；官方入口缺失时继续禁用。
- Checkpoint 4E-B2：Tasks 的 reviewed/done 拆分计数、分组和筛选；任务行 5 列语义与截止 caption 重构；Records 保留 9 列并在 1024/900 使用带提示的容器内滚动；TaskDetail 改为属性面板，补无入口可见降级、history 四态和双状态卡；状态筛选增加 group/aria-pressed；新增 B2 作用域样式与 6 项 E2E。
- Checkpoint 4E-B3：Study 改为课程工作台；摘要条、课程分组/教学班身份、跨课程搜索、全部课程视图、章节手风琴、独立 toggle/open、900 课程选择器；章节进度条修复 0/50/100 实际填充；保留 4A focus/滚动/高亮与 4C 零任务点语义。
- Checkpoint 4E-B4：Dashboard 待办/逾期集合统一使用 `now` 与 `[tasks, now]` 依赖，跨截止时间后列表和计数同步更新；通知预览改为原生 button，支持 Tab/Enter/Space、aria-label 与 focus-visible；新增同步成功/失败/部分/未连接/导入/未同步/未知的空态语义，替换紧凑 EmptyState；仅有演示通知时明确标注来源；1024 下通知卡跨两列，消除孤立布局。
- Checkpoint 4E-B4-R01：共享 `success` 不再被解释为全量平台同步完成；待办、待审核/已提交、近期截止、通知四类空态只陈述本地已加载数据，并提示平台数据可能尚未全部同步；单课程重试成功不会宣称其他课程、通知或考试已更新。通知 E2E 增加 Tab 相邻顺序、focus ring 与数据状态不变断言。
- Checkpoint 4E-B5：完成全量验收，Unit 248/248、E2E 59/59、typecheck/build 通过；采集核心 8 页 1280/1024/900 × Light/Dark 共 66 张截图，使用真实 `setZoomFactor(1.25/1.5)` 采集 28 张缩放截图；未修改生产源码、测试源码或数据库。
- Checkpoint 4E-C1：Settings 改为分组导航 + 单一内容面；7 个 section 保持常驻，新增 `.main-scroll` 内 scroll-spy、统一容器坐标、顶部/底部边界、平滑滚动抑制与用户打断、ResizeObserver 动态重算；导航增加 aria-controls/aria-current、键盘焦点与 900px 横向 active 自动可见；section 标题升级为 h2；危险操作独立视觉区；不修改保存、认证、同步、危险操作、Portal 或数据库逻辑。
- Checkpoint 4E-C1-R01：修复 1280→900 布局切换后 active 导航未滚入可视区；新增 `ensureActiveNavVisible()` 并在 activeId 与 nav 尺寸变化时校正；150% zoom 的 900.2667px CSS 视口使用 901px Settings 断点；补充真实 125%/150% Light/Dark、导入结果/同步 Mock、生命周期、动态高度和 900px active 可见测试。
- 作业附件：TaskDetail 为学习通作业附件提供应用内下载；通过官方 `ueditorupload/read` 页面解析 `cldisk.com` 签名链接，在 Portal Session 内完成预览页鉴权；跨源 Referer 改由 `webRequest.onBeforeSendHeaders` 注入，避免 Electron `net.request` 直接设置跨源 Referer 触发 `ERR_BLOCKED_BY_CLIENT`。任务列表显示附件数；下载仍走现有下载队列与工作区记录。
- Checkpoint 4E-C2：公共 Modal 增加初始焦点、Tab/Shift+Tab 循环、顶层 Escape、嵌套层级、`#root`/底层 backdrop inert 隔离和触发元素焦点恢复；附件下载记录持久化 `attachmentTaskId/attachmentObjectId/attachmentFileName/attachmentIndex`，重试与再次下载从当前任务按稳定 objectId 重新解析 objectId/fileName/referer，不再复用过期签名 URL；下载目录初始化失败直接传播到 IPC，传输阶段保持异步队列更新。
- ATT-03：历史附件下载身份从 `taskId + index` 改为 `taskId + objectId`；附件重排/删除/同名不同 ID 时仍指向原附件，删除后安全失败；旧记录缺少 objectId 时明确提示重新从任务详情下载，不回退 index；downloads 表安全新增 objectId/fileName 列，旧库和历史文件保留。
- Checkpoint 4E-C3：应用 Shell、Dashboard、Settings 与 Modal 的视觉/动效升级；侧边栏导航采用分组 rail 与 active 标记，Dashboard 统一状态带/面板/周课表/下方面板层级，Settings 保留 C1 七 section 常驻与 scroll-spy 并统一导航/内容面/表单/危险区，Modal 增加遮罩/入场动画并保留 C2 焦点管理；新增 Motion/elevation/overlay tokens 与 `prefers-reduced-motion` 降级；900px Settings 横向导航 7 项完整可见。未修改业务、C1/C2 逻辑、Portal、下载、Store/IPC/DB。
- 同步状态加固（开源研究）：持久化 `lastOutcome/lastOutcomeMessage/lastOutcomeDetail/lastOutcomeAt/lastCompleteSyncAt`；重启后按真实同步结果恢复，不再用 `authenticated + lastSyncAt` 合成 `success`；partial 不再更新 `lastSuccessAt` 或冒充完整成功；单课程重试不再覆盖全局同步状态。研究 `study_assistant`、`course_helper`、`flutter_chaoxing`、`chaoxing_ft`，未复制 GPL/高风险代码，未新增依赖。
- SYNC-R01：修复完整成功跨重启后被 partial/failure 用空值或快照导入时间覆盖；`recordSessionResult` 统一采用会话服务提供的 `lastCompleteSyncAt`，失败回调不再使用 `lastSyncAt` 冒充成功时间；新增真实临时 SQLite + 服务重建的 partial/failure/快照隔离/新成功覆盖回归。补充修复未认证 `IPC.syncRun` 仍传 `lastSyncAt` 的残留路径，统一传 `lastCompleteSyncAt ?? null`，并用实际 IPC handler 覆盖 T1/空历史两种场景。

### 测试

- B5 自动化结果：`npm test -- --run` **248/248**（27 文件）；`npm run test:e2e` **59/59**（20 文件）；`npm run build` 通过（main 355.84 kB、renderer 1,130.51 kB、CSS 212.55 kB）。
- Checkpoint 4E-C1-R02：修复已对齐导航目标重复点击后仍无条件进入滚动抑制的问题；目标滚动位置按最大可滚动范围裁剪，已到达目标时直接清理 suppression 并重新测量；新增末节裁剪、首次平滑滚动、连续导航、动态高度等回归测试。
- C1 自动化结果：C1 主 spec **5/5**、补充 spec **9/9**、关键 Scroll-spy 回归重复 **8/8**；`npm run typecheck` 通过；`npm run build` 通过（main 355.84 kB、renderer 1,140.94 kB、CSS 222.49 kB）。历史全量（C1-R02 前）：Unit **256/256**（28 文件）、E2E **69/69**（1.1m）。
- 作业附件下载：Unit **262/262**（29 文件）、E2E **74/74**（1.2m）、typecheck/build 通过（main 360.75 kB、preload 10.06 kB、renderer 1,143.84 kB、CSS 223.28 kB）。真实账号已完成两份附件下载（17,851 / 43,379 字节），文件实际存在。
- C2/ATT：Unit **267/267**（29 文件）、E2E **78/78**（1.2m）、typecheck/build 通过（main 364.48 kB、preload 10.06 kB、renderer 1,150.31 kB、CSS 223.32 kB）。真实附件首次下载、成功后再次下载、应用重启后再次下载均完成，单文件 1,062,418 字节。ATT-03 后新记录按 objectId 重试成功，旧记录安全失败。
- C3：Unit **267/267**（29 文件）、C3 专项 **5/5**、C1/C2 定向回归 **21/21**、全量 E2E **83/83**（1.3m）、typecheck/build 通过（main 364.48 kB、preload 10.06 kB、renderer 1,150.45 kB、CSS 240.96 kB）；关键界面截图保留在 `docs/screenshots/v0.5/`。
- 同步状态加固：Unit **283/283**（32 文件）、SYNC-R01 定向 **90/90**、全量 E2E **83/83**（1.2m，SYNC-R01 前）、typecheck/build 通过（main 366.53 kB、preload 10.06 kB、renderer 1,150.45 kB、CSS 240.96 kB）；新增同步状态/服务/IPC 单测 16 项。
- checkpoint 过程证据已按文档维护规则清理；`build:win` 尚未执行。

## v0.4.0 — 2026-11-14

- 学习通 Web Session 接入、课程/作业/考试/章节/通知/资料同步。
- 下载管理器、附件上传、草稿保存、提交检测、作业记录中心。
- Portal 隔离 WebContentsView 与持久会话。
