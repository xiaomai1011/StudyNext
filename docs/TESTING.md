# StudyNext 测试指南

> 本文取代原 `TEST_REPORT.md` 的逐 checkpoint 日志。测试结果是带日期的快照，不是永久承诺；当前状态见 [STATUS.md](STATUS.md)。

## 1. 测试分层

| 层        | 工具                          | 范围                                                         | 运行方式                                                                        |
| --------- | ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 单元/集成 | Vitest                        | 纯函数、SQLite、调度、导入、解析、安全校验、IPC 校验         | `npm test`                                                                      |
| 端到端    | Playwright + Electron         | 真实启动应用、CRUD、持久化、导航、截图、部分 Portal/下载流程 | `npm run test:e2e`                                                              |
| 手动验收  | 真实 Windows + 真实学习通账号 | 安装/升级/卸载、通知、Task Scheduler、真实页面解析、作业提交 | 见 [STATUS.md](STATUS.md) 与 [CHAOXING_INTEGRATION.md](CHAOXING_INTEGRATION.md) |

单元测试不能替代真实账号/真实 Windows 验收；“代码完成 + 单测通过”不等于平台真实可用。

## 2. 命令

```powershell
npm install
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run build:win
npm run verify:release
npm run format:check
```

环境注意事项：

- 本项目环境可能设置 `ELECTRON_RUN_AS_NODE=1`，启动 GUI/E2E 前必须清除。
- Playwright 必须传 `--no-sandbox --disable-gpu --user-data-dir=<工作区内可写目录>`，并设置 `STUDYNEXT_DATA_DIR` 到同一目录，避免系统临时目录的 Chromium 锁权限问题。
- 截图类 E2E 应等待 `page-in` 动画（≥300ms）结束后再拍，否则会出现过渡帧。
- 测试数据使用临时工作区，不触碰真实 `%APPDATA%\StudyNext` / `%LOCALAPPDATA%\StudyNext`。

## 3. 单元测试范围（`tests/unit/`）

覆盖的主要模块：

- 领域与任务：`domain`、`task-state`、`task-workflow`、`task-activation`、`task-protection`、`dashboard-tasks`、`dashboard-empty`、`today-schedule`、`week-timetable`、`semesters`。
- 课程与学习：`course-context`、`course-workflow`、`study-progress`、`study-search`、`materials`、`material-local-files`、`material-download-source`、`attachment-download`、`download-state`、`download-recovery`。
- 同步与快照：`sync`、`sync-service`、`sync-status`、`sync-feedback`、`sync-lifecycle`、`d005-sync-regression`、`d006-sync-operation`、`d006-transaction`、`d006-portal-guard`、`snapshot`、`import`。
- 学习通：`chaoxing`、`chaoxing-identity`、`chaoxing-transport-abort`、`credentials`、`portal-guards`、`portal-navigation`、`security`。
- 提醒：`scheduler`、`notification-retry`、`stale-delivery-retry`、`headless-reminders`、`system-reminder`。
- 存储与工作区：`storage`、`workspaces`、`user-data`。
- UI/其他：`settings-scroll-spy`、`command-search`、`modal-focus`（如存在对应单测）、`release-integrity`、`upload-events`、`ipc-sync-run`。

新增领域函数必须配单测；修复提醒/导入/安全/快照/同步逻辑必须加回归测试；新增 IPC 必须覆盖输入校验。

## 4. 端到端测试范围（`tests/e2e/`）

现有主要规格：

- `app.spec.ts`：应用启动、基础窗口与导航。
- `navigation.spec.ts`、`responsive.spec.ts`、`views.spec.ts`：三顶层标签、各页面渲染、响应式与截图。
- `command-palette.spec.ts`：Ctrl+K 命令面板搜索与跳转。
- `features.spec.ts`：任务/课程等基础功能。
- `course-workflow.spec.ts`、`task-workflow.spec.ts`、`materials-workflow.spec.ts`：课程空间、作业工作流、资料下载。
- `today-schedule.spec.ts`：今日页、日程、视图切换。
- `portal.spec.ts`、`chaoxing-ui.spec.ts`：Portal 隔离、登录态 UI、学习通页面入口。
- `account-workspace.spec.ts`、`account-restart.spec.ts`、`legacy-readonly.spec.ts`：多账号工作区、重启、只读历史库。
- `task-activation.spec.ts`：`studynext://task/<id>` 深链激活。
- `download-init-failure.spec.ts`、`checkpoint4d-download-fix.spec.ts`：下载失败与修复。
- `checkpoint4a/4b/4c/4d/4e-*`：历史 checkpoint 回归（保留作回归覆盖，不新增同类过程报告）。
- `modal-focus.spec.ts`：模态框焦点管理。

E2E 使用 `demo` 数据或临时数据库；涉及真实学习通账号的流程必须手动执行并记录在 [STATUS.md](STATUS.md)。

## 5. 带日期的基线

### 2026-11-25（仓库卫生清理）

- `npm run typecheck`：通过。
- `npm run build`：通过；`main 463.62 kB`、`preload 11.04 kB`、`renderer 1,383.46 kB`、`CSS 407.90 kB`。
- `npx playwright test tests/e2e/views.spec.ts`：1/1 通过，刷新 `docs/screenshots/v0.5` 关键截图。
- `npm test -- --run`：51 文件 / 444 项通过（Vitest 5.1.0，约 4.9 秒）。
- `npm run test:e2e`：全部 110 项通过（约 1.7 分钟）。
- `npm run format:check`：通过（Prettier 3.8.1）。

### 2026-11-22（历史基线，来自 git 历史中的 v0.5.0 测试记录）

- `npm run typecheck`：通过。
- `npm test -- --run`：37 文件 / 317 项通过。
- `npm run test:e2e`：84/84 通过（约 1.4 分钟）。
- `npm run build`：通过；`main 408.63 kB`、`preload 10.49 kB`、`renderer 1,154.29 kB`、`CSS 241.51 kB`。
- `git diff --check`：通过。
- 未覆盖：真实 Task Scheduler 定时触发、真实通知、安装器安装/升级/卸载、睡眠/权限/SQLite 锁。

### 2026-11-12（真实账号部分验收，来自 git 历史中的 v0.5.0 验收记录）

- 用户本人真实学生账号：登录态 `authenticated`；13 门课程、13 项作业、13 项截止时间、`source_url`、课表落库；连续同步不重复。
- 未验证：未登录识别、会话过期、安全验证、断网降级。

## 6. 已知测试缺口

- 真实 Windows 安装、覆盖升级、卸载、代码签名与自动更新。
- Task Scheduler 真实定时触发、通知权限关闭、睡眠/唤醒、多用户/无 SID、SQLite 锁、并发无头检查。
- 真实学习通账号的提交作业、成绩/批语回读、资料分页、复杂课表、会话过期与风控页面。
- 真实 Portal 长期运行稳定性、网络切换、代理/证书异常。
- 视觉回归目前以截图人工检查为主，没有像素级 CI 门禁。

## 7. 新增测试规则

1. 新增页面必须加入 `views.spec.ts` 与 `responsive.spec.ts`，并等待动画结束后截图。
2. 新增领域函数配单测；新增 IPC 配输入校验测试；修复提醒/导入/安全/快照/同步逻辑配回归测试。
3. 测试不得写入真实账号、密码、Cookie、Token 或真实用户数据目录。
4. 失败测试先定位原因，不得用放宽断言或跳过测试掩盖；临时跳过必须写明原因与移除日期。
5. 测试基线变化时更新本文件的“带日期的基线”，README 不写易过期测试数量。
