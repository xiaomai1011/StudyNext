# StudyNext 当前开发状态

> 本文件记录截至标注日期的开发状态、未完成项与验证基线。事实以当前源码与测试结果为准；本文件不是历史报告仓库。

## 1. 当前基线

- 日期：2026-11-25。
- 分支：`v0.4.0-development`。
- HEAD：`55f5bb5`（2026-11-14）。
- 工作区：自 HEAD 起包含多阶段累计未提交变更；未创建新 commit。
- 版本：`package.json` 为 `0.5.0`。
- 产品方向：Studio 三顶层标签“今天/课程/作业”、一站式课程空间、Dashboard 聚合、自由 UI 缩放 + Obsidian/Slate + Cobalt Blue、Portal 官方作答、AI 解题已彻底下线。

## 2. 已完成能力

- 学习通 Web Session 只读同步：课程、作业、考试、章节、学习点、通知、资料、课表。
- 作业工作流：官方页面内编辑、附件上传、草稿保存、提交检测、作业记录、成绩与教师批语读取。
- 资料中心与下载：按课程合并、下载队列、进度、取消、重试、再次下载、本机文件核验、内嵌预览。
- 多账号：DPAPI 凭据、账号切换、每账号独立 SQLite 工作区、只读历史库保护。
- 系统级 DDL 提醒：进程内调度、Task Scheduler `--check-reminders` 无头检查、失败持久化退避、`studynext://task/<id>` 激活。
- Studio UI：三顶层标签、命令面板、浅/深主题、自由缩放、日历与课表视图。

## 3. 当前未完成项

按优先级记录，括号内为来源阶段：

1. `N-008-R6`：E2E 夹具安全清理已完成，等待最终复审（已完成定向单测 29/29、E2E 9/9）。
2. `D-006-R2`：同步架构收敛，仍待完成。
3. `D-004`：打包相关收尾，仍待完成。
4. `N-002`：两项资料管理 P2 待办。
5. `N-004-R`：两个搜索 P2 待办。
6. `N-005-R2`：旧 todo 与目录完成冲突 P2。
7. `N-007`：三个非阻断 P2 待办。
8. `App.tsx` 释放后的资料/考试/通知细粒度定位接线。
9. 真实 Windows 环境：0.5.0 安装、覆盖升级、卸载、系统通知与 Task Scheduler 定时触发验收。
10. 真实学习通账号：提交作业、成绩/批语回读、资料分页、会话过期/安全验证等全流程验收。

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
- 文档入口见 [README.md](../README.md) 的“文档”一节。
- 工作区仍有未提交源码变更；不要在没有确认的情况下 `git reset`、`git clean` 或覆盖用户数据。
- 新增功能或改变架构时，同步更新 [ARCHITECTURE.md](ARCHITECTURE.md)、[FEATURE_MAP.md](FEATURE_MAP.md)、[TESTING.md](TESTING.md) 与本文件。
