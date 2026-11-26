# StudyNext 已知问题与工程教训

> 本文件只保留仍然有效的当前问题与可复用的工程教训。历史 checkpoint 的过程记录已移除；需要追溯时查 git 历史。当前开发状态见 [STATUS.md](STATUS.md)，测试缺口见 [TESTING.md](TESTING.md)。

## 1. 当前已知问题

### P0 / 发布阻断

目前没有代码级 P0。发布前仍需完成真实 Windows 安装与真实学习通账号验收；在这些验收完成前，不能把 v0.5.0 描述为“已发布可用”。

### P1 / 发布前必须处理

| 编号 | 问题                                                      | 影响                                                | 处理方向                                                    |
| ---- | --------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| I-01 | 安装包未签名，也未接入自动更新                            | 用户安装会出现 SmartScreen 警告，升级依赖手动下载   | 发布前完成代码签名与更新策略；不要承诺自动更新              |
| I-02 | 真实 Windows 安装/覆盖升级/卸载未验证                     | NSIS 脚本、快捷方式、数据目录在真实安装环境可能失败 | 在干净 Windows 环境逐项验收并记录到 `STATUS.md`             |
| I-03 | Task Scheduler 定时触发、真实通知点击未验证               | 应用退出后的 DDL 提醒可能不触发或点击不激活任务     | 在已安装版本上验证注册、触发、点击、注销与重装              |
| I-04 | 真实学习通账号全流程验收未完成                            | 页面解析、提交状态、成绩批语可能随平台改版失效      | 用用户本人账号手动验收；失败即降级并保留原因                |
| I-05 | 部分作业无 `submittedAt`，详情未完整读取时状态为 `unread` | UI 不能显示精确提交时间，统计可能偏保守             | 保持 `unread`，不得猜测；等待平台返回或用户手动核对         |
| I-06 | 资料分页仅部分验证，下载失败原因未持久化                  | 大量资料可能漏抓；失败只能显示“下载失败或中断”      | 增加分页回归；在 `downloads` 表增加失败原因字段后再展示细节 |
| I-07 | 应用图标为本地生成的占位品牌图标                          | 正式发布形象不完整                                  | 发布前做视觉定稿并替换图标资源                              |

### P2 / 应尽快处理

| 编号 | 问题                                                                                        | 影响                                                                       |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| I-08 | `App.tsx` 释放后的资料/考试/通知细粒度定位接线未完成                                        | 从今日页/命令面板跳转后可能只到页面，未定位到具体条目                      |
| I-09 | N-002 资料管理两项 P2、N-004 搜索两项 P2、N-005 旧 todo 与目录完成冲突、N-007 三项非阻断 P2 | 功能可用但体验不一致，长期会积累小债                                       |
| I-10 | 学习通页面解析依赖 DOM/HTML，平台改版会导致部分字段失败                                     | 解析器必须保持可观测、可回退；失败不得显示成功                             |
| I-11 | `CourseWorkspace.tsx` 128 KB、`App.tsx` 1,939 行，页面状态集中                              | 后续修改冲突概率高；重构前先补测试，不要先动结构                           |
| I-12 | 资料下载队列状态与本地文件核验存在边界情况                                                  | 队列清空、文件被手动删除、记录丢失时需要可恢复；已有单测但真实环境仍需验证 |

### P3 / 工程卫生

| 编号 | 问题                                                                      | 处理建议                                                      |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| I-13 | E2E 运行会生成 `.tmp-e2e-*` 临时目录与测试 profile                        | 在 workspace 可写目录内运行并及时清理；不要用共享系统 profile |
| I-14 | 文档索引与代码/截图路径可能随重构失效                                     | 按 AGENTS.md §11 维护；只保留长期文档，不新增过程报告         |
| I-15 | 通知权限关闭、睡眠/唤醒、多用户/无 SID、SQLite 锁、并发无头检查未系统验证 | 逐项加入真实环境验收清单                                      |
| I-16 | 代码签名、发布哈希与安装包版本一致性依赖手工脚本                          | 每次发布运行 `npm run verify:release` 并核对 manifest         |

## 2. 工程教训

以下编号保留历史来源，方便在 git 历史或旧文档中检索。每条都是“踩过坑后的结论”，不是待办。

### 环境与启动

- **P1 npm postinstall 被拦截**：Electron 下载脚本可能被安全策略阻断；可执行 `node node_modules/electron/install.js` 补装，仅限当前主机，不要写进项目脚本。
- **P2 Electron 45 启动崩溃 `0xc0000005`（地址 `0x7e7090b`）**：发生在 `app.whenReady()` 之前，根因是 user-data-dir 不可写/默认 profile 问题；显式传入可写 `--user-data-dir` 可规避，不是业务代码崩溃。
- **P3 AppData 目录 `EPERM`**：数据目录只允许 `%LOCALAPPDATA%`、应用数据目录或显式 `STUDYNEXT_DATA_DIR`；不要回退到系统临时目录，否则用户数据会“消失”。
- **P4 `ELECTRON_RUN_AS_NODE=1`**：会让 Electron 以纯 Node 运行，GUI/E2E 启动前必须清除。
- **P5 Chromium profile 锁（错误 5）**：每个测试/实例使用独立可写 `--user-data-dir`，并让 `STUDYNEXT_DATA_DIR` 指向同一目录。
- **P6 系统代理 `HTTP_PROXY=http://127.0.0.1:7897`**：会破坏 `--host-resolver-rules`；E2E 仅测试环境加 `--no-proxy-server`。
- **P7 本地 HTTPS 证书不受信任**：测试专用 `setCertificateVerifyProc(callback(0))`，绝不要在生产代码关闭证书校验。
- **P37 Electron 45 默认 profile 崩溃与权限相关**：升级到 45.3.0 并隔离 E2E 工作区；不要用共享系统 profile。

### 类型、数据与导入

- **P8 `exactOptionalPropertyTypes` 报错**：用条件展开/默认值/`toTaskUpsertInput`/`toSettingsPatch` 构造对象，不要用 `undefined` 强塞可选字段。
- **P9 课程筛选 `courseId: null`**：`null` 表示“未关联课程”，字段省略表示“全部”；用条件展开构造查询，不要混淆。
- **P10 收藏 schema 用错 ID 字段**：固定为 `favoriteSchema = z.object({ id: z.string().uuid(), favorite: z.boolean() }).strict()`。
- **P11 `shell.openPath` 失败静默**：包装 `UserFacingError('OPEN_DIRECTORY_FAILED', message)`，让用户看到可理解错误。
- **P12 跨课程快照 ID 冲突**：唯一索引必须是 `(course_id, source, external_id)`，任务 externalId 要带课程前缀。
- **P13 快照重复导入**：顶层与嵌套 homework 会重复，用 `taskKeys`/`addParsedTask` 去重。
- **P14 `Boolean('false') === true`**：解析完成状态必须显式匹配 `true/1/yes/done/complete/completed/已完成`，不能直接 `Boolean()`。
- **P15 进度 `1` 与 `"1%"` 歧义**：数值 0–1 视为比例，显式百分号字符串按百分比；两者不可混用。
- **P16 快照导入冒充实时同步**：来源固定 `import`，文案必须“本地快照 · 非实时同步”，不得计为学习通同步成功。
- **P17 章节进度被旧快照覆盖**：有学习点时按学习点计算，`Math.max()` 不能直接覆盖旧值。
- **P33 增量导入覆盖手动修改**：保留 `manualFields`/`fieldSources`/`completionSource`/`task_change_log`；`upsertImportedTask` 合并字段，平台完成状态不得覆盖本地手动完成。
- **P38 提交/批阅后任务状态陈旧（v0.5.0 根因）**：只监听 `/work/prompt` 会漏；`retryCourse` 在全局同步中可能返回旧状态；`isPlatformTaskDone` 曾把 `submitted/pending_review` 当本地完成。修复为 `webRequest.onCompleted` 监听 POST（排除 `saveStatus=1`）、`CHAOXING_RETRY_BUSY`、六态拆分、数据保护合并、集中自动刷新；`submittedAt` 仍可能为空，真实提交必须由用户验收。

### UI、截图与可访问性

- **P20 托盘关闭后进程残留**：`closeToTray=false` 时 `mainWindow.on('closed')` 要在非主动退出时 `app.quit()`。
- **P21 `will-download` 重复注册**：Portal 每次打开都注册会叠加监听；应在 `configureSession()` 注册一次。
- **P22 CSP 允许内联脚本**：必须 `script-src 'self'`；Portal 探针确认 `require`/`process`/`module`/`window.studynext`/`window.electron`/`window.ipcRenderer` 均为 `undefined`。
- **P23 Portal 测试不能用 mock**：必须用真实 `WebContentsView`；被阻止的导航要保持原 URL。
- **P24 单测假设 `listChapters()` 按课程过滤**：实际 API 不按课程过滤；修测试而不是改存储 API。
- **P25 Playwright 选择器与 DOM 不匹配**：用 `.metric-value`、`.study-point:not(.done)`，先点课程再断言。
- **P26 截图被 220ms `page-in` 动画洗白**：等待 ≥300ms 再截图。
- **P27 Portal E2E 的代理/证书问题**：按 P6/P7 处理，不要在生产代码放宽校验。

### 文档、发布与编码

- **P28 安装包大小/哈希漂移**：0.1.0 为 106,037,349 bytes / `D643...`，0.2.0 为 106,052,543 bytes / `8C409...`；每次重建都会变化，文档必须引用实际产物。
- **P29 CP936 乱码事故（最严重）**：PowerShell `.Replace`/`Get-Content` 默认 CP936 曾把 `src/main/storage/store.ts` 96 行、`src/main/integrations/snapshot.ts` 31 行中文破坏，引号丢失；从 `.tmp-store-corrupt.ts`/`.tmp-recovery-b38.txt`/`.tmp-store-rebuilt.ts`/`.tmp-snapshot-base.ts` 恢复。结论：中文文件只用 `edit`/显式 UTF-8，禁止 PowerShell 批量替换。
- **P30 文档沿用旧测试数字/哈希**：升级后 README/TEST_REPORT/DELIVERY 必须同步更新；现在统一记录到 `TESTING.md` 并带日期。
- **P31 文档夸大楼项目文件数**：DELIVERY 声称 108 个，实际 91 个（排除 node_modules/out/release/test-results/\*.tsbuildinfo）；数字要重新计算，不凭记忆。
- **P32 数据目录静默回退临时目录**：`user-data.ts` 只允许 LOCALAPPDATA/app data/显式 env，找不到就报错退出，不能悄悄换目录。
- **P34 Portal 导航日志泄露 query token**：只记录 `origin + pathname`，最多 30 条。
- **P35 登录状态误判**：`unknown/logged_out/logged_in` 曾把“页面能打开”当登录；后来扩展为 `unknown/logged_out/authenticated/expired`，且不做 token 校验。
- **P36 SSO 域名被拦截**：`trustedSsoDomains` 仅允许 HTTPS/443、无 userinfo、精确或子域名匹配、最多 20 个。

## 3. 维护规则

1. 新增问题先查是否已有编号；新问题用 `I-xx`（当前问题）或 `Pxx`（历史教训）记录，避免重复。
2. 修复 P1/P2 问题后，在原条目补“已修复版本/日期”，不要直接删除。
3. 真实环境验收结果写入 `STATUS.md`，测试基线写入 `TESTING.md`，不要在本文件堆测试日志。
4. 发布前逐项检查 §1 的 P0/P1；未验证项不得写成“已支持”。
