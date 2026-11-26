# StudyNext 当前开发状态

> 本文件记录截至标注日期的开发状态、未完成项与验证基线。事实以当前源码与测试结果为准；本文件不是历史报告仓库。

## 1. 当前基线

- 日期：2026-11-26。
- 分支：`v0.4.0-development`。
- 版本：`package.json` 为 `0.5.0`。
- 工作区：已整理并提交到公开仓库 `xiaomai1011/StudyNext`；当前源码以最新提交为准。
- 产品方向：Studio 三顶层标签“今天/课程/作业”、一站式课程空间、Dashboard 聚合、自由 UI 缩放 + Obsidian/Slate + Cobalt Blue、Portal 官方作答、AI 解题已彻底下线。

## 2. 已完成能力

- 学习通 Web Session 只读同步：课程、作业、考试、章节、学习点、通知、资料、课表。
- 作业工作流：官方页面内编辑、附件上传、草稿保存、提交检测、作业记录、成绩与教师批语读取。
- 资料中心与下载：按课程合并、下载队列、进度、取消、重试、再次下载、本机文件核验、内嵌预览。
- 多账号：DPAPI 凭据、账号切换、每账号独立 SQLite 工作区、只读历史库保护。
- 系统级 DDL 提醒：进程内调度、Task Scheduler `--check-reminders` 无头检查、失败持久化退避、`studynext://task/<id>` 激活。
- Studio UI：三顶层标签、命令面板、浅/深主题、自由缩放、日历与课表视图。

## 3. 当前未完成项

按优先级记录：

1. 真实 Windows 环境：0.5.0 安装、覆盖升级、卸载、系统通知与 Task Scheduler 定时触发验收。
2. 真实学习通账号：提交作业、成绩/批语回读、资料分页、会话过期/安全验证等全流程验收。
3. 安装包签名、自动更新与正式发布流程。
4. 学习通页面解析随平台改版维护；复杂课表（单双周/调休/多教师）与资料分页仍需继续验证。
5. 桌面端发布前的视觉定稿与安装体验完善。

## 4. 最近验证记录

### 2026-11-25（仓库卫生清理）

- `npm run typecheck`：通过。
- `npm run build`：通过；`main 463.62 kB`、`preload 11.04 kB`、`renderer 1,383.46 kB`、`CSS 407.90 kB`。
- `npx playwright test tests/e2e/views.spec.ts`：1/1 通过，刷新 `docs/screenshots/v0.5` 关键截图。
- `npm test -- --run`：51 文件 / 444 项通过（Vitest 5.1.0，约 4.9 秒）。
- 全量 `npm run test:e2e`：110/110 通过（1.7 分钟）。
- `npm run format:check`：通过（全仓 Prettier 3.8.1）。

### 2026-11-22（历史基线，来自 git 历史中的 v0.5.0 测试记录）

- `npm run typecheck`：通过。
- `npm test -- --run`：37 文件 / 317 项通过。
- `npm run test:e2e`：84/84 通过（约 1.4 分钟）。
- `npm run build`：通过；`main 408.63 kB`、`preload 10.49 kB`、`renderer 1,154.29 kB`、`CSS 241.51 kB`。
- `git diff --check`：通过。
- 未覆盖：真实 Task Scheduler 定时触发、真实通知、安装器安装/升级/卸载、睡眠/权限/SQLite 锁。

### 2026-11-12（真实账号部分验收，来自 git 历史中的 v0.5.0 验收记录）

- 用户本人真实学生账号：登录态 `authenticated`；课程、作业、截止时间、`source_url`、课表落库；连续同步不重复。
- 未验证：未登录识别、会话过期、安全验证、断网降级。
- 该结果仅证明当时链路可用，不代表最新代码或所有账号环境通过。

## 5. 发布前检查清单

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] `npm run build:win`
- [ ] `npm run verify:release`
- [ ] 真实 Windows 安装/覆盖升级/卸载
- [ ] 真实学习通账号全流程验收
- [ ] 安装包签名与更新策略确认

## 6. 文档与仓库状态

- 2026-11-25 完成仓库卫生清理：删除历史过程报告与重复文档，合并学习通/提醒/测试文档，保留当前关键截图。
- 2026-11-26 将仓库整理为公开的 `xiaomai1011/StudyNext`，完善 README、仓库描述、主题标签与项目元数据。
- 文档入口见 [README.md](../README.md) 的“文档导航”一节。
- 不要把账号、密码、Cookie、Token 或真实用户数据提交到仓库；迁移或清理数据前先备份。
- 新增功能或改变架构时，同步更新 [ARCHITECTURE.md](ARCHITECTURE.md)、[FEATURE_MAP.md](FEATURE_MAP.md)、[TESTING.md](TESTING.md) 与本文件。
