# StudyNext 开发问题记录与开源项目审查说明

记录日期：2026-11-11  
对应版本：StudyNext 0.2.0

这份文档回答两个问题：

1. 开发过程中实际遇到过哪些问题，分别是怎么定位和处理的；
2. 对需求中列出的 GitHub 参考项目，实际看到了什么程度，哪些看过、哪些没有逐行读。

## 1. GitHub 参考项目审查结论

先给结论：**看了仓库主页、README、LICENSE、语言和目录结构，也对比了功能划分；没有把四个仓库全部 clone 下来逐文件审阅，更没有复制代码。**

需求中列出的四个项目，以及当前分享会话里提到的 `xuexitong-cli`，审查深度如下。

| 项目                                                                                                        | 实际查看内容                                                                                                                                                                                                                               | 没有做的事                                                                                                    | 在本项目中的使用方式                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Cooanyh/chaoxing-list](https://github.com/Cooanyh/chaoxing-list)                                           | 仓库主页、README、AGPL-3.0 LICENSE、根目录文件树；确认它是基于 `lcandy2/chaoxing-assignment` 修改的 2.5.0 用户脚本，核心文件 `chaoxing-list.user.js` 约 356 KB；确认其功能包括待办、作业、考试、课程任务、课程进度、读取异常提示和截止提醒 | 没有 clone 后逐行阅读 356 KB 用户脚本；没有运行脚本；没有复制其中的 DOM 选择器、接口调用或 UI 代码            | 只借鉴“跨课程任务聚合、截止时间优先、同步状态要明确提示”的信息架构；本项目用 React/SQLite 独立实现               |
| [mshzy/study_assistant](https://github.com/mshzy/study_assistant)                                           | 仓库主页、README、MIT LICENSE、根目录；确认主代码在 `local_app`，是 Flutter 本地应用，README 说明登录、作业同步、提醒和桌面小组件都在该目录                                                                                                | 没有逐文件阅读 Dart/Flutter 实现；没有把它的同步逻辑移植到 Electron；没有运行 Flutter 应用                    | 只参考“课程与任务分离、提醒预设、同步失败要显式呈现”的产品划分；数据模型和 UI 为独立实现                         |
| [helloene/chaoxing-xuexitong-student-portal](https://github.com/helloene/chaoxing-xuexitong-student-portal) | 仓库主页、README、MIT LICENSE、文件列表；确认是 14 个入口的纯静态 PWA 导航页，包含 `index.html`、`script.js`、`styles.css`、`sw.js` 等                                                                                                     | 没有复制它的 HTML/CSS/JS，也没有照搬它的视觉设计；没有把它当作数据接口                                        | 只把官方入口 URL 作为事实性配置参考；本项目入口由 `BUILTIN_ENTRIES` 独立维护                                     |
| [unraous/uxuescript](https://github.com/unraous/uxuescript)                                                 | 仓库主页、README、GPL-3.0 LICENSE、目录结构；确认是基于 Rust + Tauri 2 + Vue 3 的自动刷课/AI 答题客户端，包含 `injected/` 课程脚本、`src-tauri/`、AI 答题和考试辅助说明                                                                    | 没有阅读或复制 `injected/chaoxing/course.js` 的自动化实现；没有复用其字体还原、题目提取或答题逻辑；没有运行它 | 功能方向明确排除；只把“桌面端 + 内嵌 WebView + 本地模型配置”的产品形态作为反面边界参考。GPL-3.0 代码未进入本项目 |
| `xuexitong-cli`（分享会话中提到，不是原始四个仓库之一）                                                     | 只看到分享会话中的功能描述：MIT、只读数据函数如 `list_courses`、`list_chapters`、`list_homework`、`get_homework_deadlines`、`list_exams`、`list_notices`、`get_schedule`                                                                   | 没有 clone 该仓库，也没有逐文件核对其实现；没有把它的接口调用、登录流程或代码复制进 StudyNext                 | 作为后续“授权只读数据适配器”的概念参考；当前实时适配器仍是 `not_configured`，没有声称已接入                      |

### 1.1 为什么没有把四个仓库全部逐行读完

- 两个项目的技术栈与当前工程不兼容：`chaoxing-list` 是浏览器用户脚本，`study_assistant` 是 Flutter；逐行读并不能直接复用。
- `uxuescript` 明确是自动刷课/AI 代答工具，功能方向与当前产品边界冲突，且为 GPL-3.0；只做许可与能力层面的排除记录，不进入实现。
- 静态门户项目只需要确认入口清单和“官方页面承载”的产品思路，代码量不大但没有复制价值。
- 真正需要严谨对待的是许可证和数据来源，所以在 `docs/research.md` 记录了来源、许可证和复用结论，并在本项目内独立实现。

### 1.2 许可证记录

| 项目                                       | 许可证            | 是否复制代码 |
| ------------------------------------------ | ----------------- | ------------ |
| Cooanyh/chaoxing-list                      | AGPL-3.0          | 否           |
| mshzy/study_assistant                      | MIT               | 否           |
| helloene/chaoxing-xuexitong-student-portal | MIT               | 否           |
| unraous/uxuescript                         | GPL-3.0           | 否           |
| xuexitong-cli                              | MIT（仅会话描述） | 否           |

## 2. 实际遇到的问题

### 2.1 环境、安装和启动

#### P1. npm 安装脚本被拦截，Electron 二进制缺失

- 现象：`npm install` 成功，但 `node_modules/electron/dist` 不存在，启动时报 Electron 二进制缺失。
- 原因：当前环境的 `allowScripts` 策略拦截了 Electron 的 postinstall 脚本。
- 处理：执行 `node node_modules/electron/install.js` 补下载二进制；正式项目保留正常的 `postinstall` 安装方式。
- 影响：只影响当前自动化宿主，不影响源码逻辑。

#### P2. Electron 45 在当前宿主启动即崩溃

- 现象：Electron 45.3.0 在业务代码加载前崩溃，退出码 `0xc0000005`，崩溃偏移约 `0x7e7090b`；最小复现脚本同样复现。
- 排查：确认崩溃发生在 `app.whenReady()` 之前；改用显式已存在、可写的 `--user-data-dir` 后可启动，说明宿主默认 profile/目录权限是触发因素之一，而不是 React 或 SQLite 代码。
- 处理：降到同宿主验证稳定的 Electron 38.8.6；同时增加数据目录候选和 `STUDYNEXT_DATA_DIR` 覆盖。
- 仍未完全消除的限制：干净 Windows 10/11 机器上仍建议复测 Electron 45；当前交付以 38.8.6 为准。

#### P3. 默认 AppData 目录创建失败

- 现象：`EPERM: operation not permitted, mkdir 'C:\Users\...\AppData\Roaming\StudyNext'`。
- 原因：当前自动化宿主对 Electron 子进程写入 AppData/Temp 有限制；系统 Node 可以写，但 Electron 子进程被策略拦截。
- 处理：`resolveUserDataPath()` 依次尝试 `%LOCALAPPDATA%\StudyNext`、`%APPDATA%\StudyNext`、系统临时目录 `StudyNext`；仍失败时提示设置 `STUDYNEXT_DATA_DIR`。
- 测试处理：E2E 使用工作区下 `.tmp-e2e-*` 作为数据目录，避免读写真实用户数据。

#### P4. `ELECTRON_RUN_AS_NODE=1` 导致 GUI 启动异常

- 现象：启动 Electron 后行为像 Node 进程，窗口不出现。
- 原因：当前 shell 环境存在 `ELECTRON_RUN_AS_NODE=1`。
- 处理：启动 GUI 前清除该环境变量：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

#### P5. E2E 的 Chromium profile 锁错误

- 现象：使用系统临时目录或 AppData 时出现 `Lock file can not be created`，错误码 5。
- 原因：宿主目录权限和残留 profile 锁。
- 处理：每个 E2E 用例使用工作区内唯一的 `--user-data-dir` 和 `STUDYNEXT_DATA_DIR`，结束后递归清理；`rmSync` 增加重试。

#### P6. 系统代理破坏 Portal 测试的 DNS 映射

- 现象：`--host-resolver-rules=MAP test.chaoxing.com 127.0.0.1` 不生效，Portal 测试连不到本地 HTTPS 服务。
- 原因：环境设置了 `HTTP_PROXY=http://127.0.0.1:7897`，代理接管了请求。
- 处理：E2E 启动参数增加 `--no-proxy-server`；这是测试参数，正式应用不默认关闭用户代理。

#### P7. 本地 HTTPS 测试证书不被 Electron 接受

- 现象：Portal 测试页加载失败，错误为证书不受信任。
- 处理：测试内使用 `session.fromPartition('persist:studynext-portal').setCertificateVerifyProc((_request, callback) => callback(0))` 仅接受测试证书；正式应用仍执行正常证书校验。

### 2.2 TypeScript 与数据模型

#### P8. `exactOptionalPropertyTypes` 引发的编译错误

- `BrowserWindow` 选项中的 `x`/`y` 类型为 `number | undefined`，与 `number` 不兼容。
- `import.ts` 中 `compact[1]`、`compact[2]` 可能为 `undefined`。
- IPC 层把 `status?: TaskStatus` 和 settings patch 的 `undefined` 直接传给严格输入类型。
- 处理：条件展开 `...(state.x !== undefined ? { x: state.x } : {})`、`??` 默认值、`toTaskUpsertInput`/`toSettingsPatch` 只传递已定义字段。

#### P9. 任务筛选把“全部课程”和“未关联课程”混为一谈

- 现象：任务页选择“全部课程”时，实际把 `courseId: undefined` 传给了筛选函数，结果是空列表或错误列表。
- 原因：`filterTasks` 中 `courseId: null` 表示“未关联课程”，省略字段才表示不筛选。
- 处理：改为条件展开：

```ts
...(courseId !== 'all' ? { courseId } : {})
```

#### P10. 初始校验 schema 使用了错误的 ID 字段

- 现象：课程收藏校验误用了 `taskId`。
- 处理：改为 `favoriteSchema = z.object({ id: z.string().uuid(), favorite: z.boolean() }).strict()`。

#### P11. 打开数据目录没有错误反馈

- 现象：`shell.openPath` 失败时没有提示。
- 处理：改为 async，检查返回的 message 并抛出 `UserFacingError('OPEN_DIRECTORY_FAILED', message)`。

#### P12. 快照解析的跨课程 ID 冲突

- 现象：不同课程使用相同章节/学习点外部 ID 时，第二次导入会覆盖第一次或命中错误记录。
- 处理：章节/学习点唯一索引从全局 `(source, external_id)` 改为 `(course_id, source, external_id)`；查询也按 `course_id` 过滤。
- 任务外部 ID 增加课程前缀，避免不同课程的同名任务冲突。

#### P13. 快照任务重复导入

- 现象：同一快照既有顶层 `homeworks` 又有课程内嵌 `homeworks` 时，任务可能被导入两次。
- 处理：`taskKeys`/`addParsedTask` 统一去重；嵌套任务只遍历一次；`externalId` 加课程前缀后再比较。

#### P14. 布尔值字符串解析错误

- 现象：`valueToBoolean('false')` 曾因为 `Boolean('false') === true` 被当作已完成。
- 处理：只接受 `true`、`1`、`yes`、`done`、`complete`、`completed`、`已完成` 等显式值。

#### P15. 进度字段的 1 到底是 1% 还是 100%

- 现象：数值 `1` 和字符串 `"1%"` 语义不明确。
- 处理：显式百分比字符串按百分比处理；数值 `0–1` 视为比例（`0.5` → 50%）；增加单元测试锁定行为。

### 2.3 运行时、安全和产品语义

#### P16. 快照导入被误标成“学习通实时同步”

- 现象：`recordSnapshotImport` 曾设置 `source: 'chaoxing'`，Dashboard 标题栏出现“已连接学习通数据源”，实际数据只是本地 JSON。
- 处理：快照导入固定 `source: 'import'`；Dashboard、Settings、App 标题栏改为“本地快照 · 非实时同步”；`SyncStatus` 保留 `snapshot` 元数据。
- 这是本项目最重要的产品语义修复之一：**未授权数据不冒充实时同步。**

#### P17. 学习中心章节进度被旧快照覆盖

- 现象：`Study.tsx` 使用 `Math.max(progress, chapter.progress)`，导致快照中的旧百分比压过用户刚勾选的学习点进度。
- 处理：存在学习点时使用根据学习点计算的 `progress`；只有没有学习点时才显示快照章节进度。

#### P18. AI Key“删除旧 Key”和“输入新 Key”同时生效

- 现象：用户输入新 Key 同时勾选删除，后端先清除后保存，结果 Key 丢失。
- 处理：前端输入新 Key 时自动取消 `clearAiKey`；保存时只在没有新 Key 的情况下传 `clearApiKey`；后端让非空新 Key 优先于 clear 标记。

#### P19. AI 配置和请求的安全边界

- Base URL 只接受 HTTPS；仅对 localhost 允许 HTTP，便于本地模型调试。
- Key 通过 Electron `safeStorage` 加密，不写入日志，不进入渲染器持久化，不随题库导出。
- 只把用户当前输入的题目发送到用户配置的接口；应用不内置共享 Key。
- 当前限制：AI 请求的真实网络行为由用户配置决定，自动化测试只验证 URL、提示词和响应解析，没有在无 Key 环境发起真实模型调用。

#### P20. `closeToTray=false` 时关闭窗口仍常驻

- 现象：托盘存在时关闭窗口，进程不退出。
- 处理：`mainWindow.on('closed')` 在 `!isQuitting` 时调用 `app.quit()`；`before-quit` 负责后续清理。

#### P21. Portal 每次打开都重复注册下载拦截

- 现象：`will-download` 在每次 `open` 时注册，频繁打开会增加监听器并重复触发。
- 处理：把 `will-download` 移到 `configureSession()`，每个隔离 session 只注册一次；仍然阻止下载。

#### P22. CSP 仍允许内联脚本

- 现象：`index.html` 的 `script-src` 原先包含 `'unsafe-inline'`。
- 处理：收紧为 `script-src 'self'`；`style-src` 保留 inline 以支持 React 内联样式。
- 验证：Portal E2E 的页面探针确认 `require`、`process`、`module`、`window.studynext`、`window.electron`、`window.ipcRenderer` 全部为 `undefined`。

#### P23. Portal 测试需要真实 WebContentsView，而不是 mock

- 处理：测试通过 `BrowserWindow.getAllWindows()[0].contentView.children.find(child => 'webContents' in child)` 取得真实视图，加载本地 HTTPS 探针页；跳转 `https://example.com/blocked` 后断言状态为 `blocked` 且 URL 没有离开白名单。

### 2.4 测试与视觉

#### P24. 单元测试期望 `listChapters()` 带课程过滤

- 现象：测试调用 `store.listChapters()` 后按 `courseId` 过滤，错误地假设方法本身带筛选。
- 处理：修正测试为 `listChapters().filter(chapter => chapter.courseId === ...)`；不改变存储 API 的语义。

#### P25. Playwright 选择器与实际 DOM 不一致

- `.metric-note` 不存在，指标值使用 `.metric-value`。
- 学习点只有 `.done` 状态类，没有 `.todo`；改为 `.study-point:not(.done)`。
- 导入快照后课程出现在侧栏但没有自动选中；改为先点击“测试快照课程”再断言学习点。

#### P26. 截图发白是动画时序问题

- 现象：Dashboard/Settings 截图在 220 ms 的 `page-in` 动画结束前拍摄，显得发白。
- 处理：截图前等待动画结束（约 300 ms）；不是 CSS 或渲染故障。

#### P27. Portal E2E 的代理与证书问题

- 见 P6、P7；这两个问题曾导致测试失败，最终通过 `--no-proxy-server` 和测试专用证书回调解决。

### 2.5 打包、文档和源文件

#### P28. 安装包版本、大小和哈希多次变化

- 0.1.0 安装包为 106,037,349 bytes，哈希 `D643...`；0.2.0 最终包为 106,052,543 bytes，哈希 `8C409...`。
- 处理：最终以 `release/StudyNext-Setup-0.2.0.exe` 为准；README、TEST_REPORT、DELIVERY 已统一为最终值。
- 注意：文档修改不会改变安装包；如果以后修改源码，必须重新 `build:win` 并更新哈希。

#### P29. PowerShell 批量替换导致中文源码乱码（最严重的一次事故）

- 现象：一次为把快照来源改成 `import` 的 PowerShell `.Replace`/`Get-Content` 批量编辑，把 `src/main/storage/store.ts`（96 个非 ASCII 行）和 `src/main/integrations/snapshot.ts`（31 个非 ASCII 行）的中文变成 CP936 乱码，部分引号也丢失，文件语法损坏。
- 原因：PowerShell 默认编码与 UTF-8 源文件不一致，批量文本替换没有按 UTF-8 读写。
- 处理：
  1. 保留损坏副本作为 `.tmp-store-corrupt.ts`；
  2. 用 `.tmp-recovery-b38.txt` 中的原始存储读取和 15 次编辑记录，重建 `.tmp-store-rebuilt.ts`；
  3. 用 `.tmp-snapshot-base.ts` 的原始字面量逐行修复 `snapshot.ts` 的 30 个损坏行；
  4. 恢复课程作用域唯一索引、`source: 'import'` 和所有中文提示；
  5. 重新运行 `typecheck`、40 项单元测试、5 个 E2E，全部通过。
- 教训：以后修改中文 TypeScript 源码统一用 `edit` 工具或显式 UTF-8 读写；不再用 PowerShell 批量替换源文件。

#### P30. 文档长期保留 0.1.0 的测试数字和哈希

- 现象：源码升级到 0.2.0 后，README、TEST_REPORT、DELIVERY 仍写 32 项测试、4 个 E2E、旧哈希。
- 处理：全部改为 8 个单测文件/40 项、5 个 E2E、0.2.0 安装包和最终哈希；`format:check`、`typecheck`、`test`、`test:e2e` 重新跑过。

#### P31. 交付文档中的项目文件数不准确

- 现象：DELIVERY.md 曾写“108 个项目文件”，但按排除 `node_modules`、`out`、`release`、`test-results` 和 `*.tsbuildinfo` 的口径重新统计，实际为 91 个。
- 原因：早期统计包含了不同阶段的临时产物，后续文档没有随文件增删重新计算。
- 处理：改为 91，并明确统计口径；新增 ISSUES.md 后同步把它列入文档清单。
- 教训：文件数不是核心指标，但既然写进交付报告，就必须可复现；以后用一条 PowerShell 命令重新生成，不凭记忆填写。

## 3. 仍然存在的限制

这些不是“已经解决”的问题，而是当前版本的真实边界：

1. **实时学习通接入未配置**：没有找到面向个人开发者公开可申请的 OAuth/课程接口文档；`ChaoxingAuthorizedAdapter.isConfigured()` 仍固定返回 `false`，UI 显示未配置，不以演示数据或快照冒充实时同步。
2. **快照是手动导入**：没有定时拉取、增量同步和冲突合并；重复导入已有任务时当前会跳过，不会自动更新已存在任务的截止时间。
3. **退出后没有定时提醒**：主进程退出后定时器停止；重新启动会补发最近 10 分钟内错过的提醒。界面已明确说明，不声称后台常驻。
4. **AI 真实调用取决于用户配置**：无内置共享 Key；自动化测试只覆盖 URL 校验、消息构造和响应解析。
5. **安装包未代码签名**：Windows 可能显示未知发布者；这不影响本地安装，但发布前需要证书。
6. **Electron 版本受宿主影响**：当前用 38.8.6 交付；Electron 45 在该自动化宿主默认 profile 下崩溃，建议在干净 Windows 虚拟机复测后再升级。
7. **没有实现自动刷课、签到、考试代答、验证码绕过、反爬或监考绕过**：这是产品边界，不是未完成 bug。
8. **没有逐行审阅四个开源仓库的全部源码**：如第 1 节所述，只做了仓库级/README/许可证/目录级调研；本项目没有复制任何第三方代码。

## 4. 复现验证

```powershell
cd D:\Documents\deepseek-harness\default-workspace\studynext
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run build:win
```

当前结果：

- `npm run typecheck`：通过
- `npm test`：8 个文件、40/40 通过
- `npm run test:e2e`：5/5 通过
- `npm run build`：通过
- `npm run build:win`：通过，产物为 `release/StudyNext-Setup-0.2.0.exe`
- 打包版启动：`title=学习总览`、`version=0.2.0`、`packaged=true`

## 5. 相关文档

- [参考项目与开放能力调研](./research.md)
- [优化落地记录](./OPTIMIZATION.md)
- [测试报告](./TEST_REPORT.md)
- [交付报告](./DELIVERY.md)
- [架构说明](./ARCHITECTURE.md)
