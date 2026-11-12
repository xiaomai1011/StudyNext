# 学习通真实数据接入可行性报告

- 版本：StudyNext 0.3.0
- 调研日期：2026-11-11 / 2026-11-12
- 结论先行：**当前没有找到可公开申请、可供个人开发者直接使用的学习通 OAuth / 开放数据接口。**
  现有可运行的 `xuexitong-cli` 实现依赖登录 Cookie、网页 HTML 解析和未公开接口，
  不能作为 StudyNext 未经授权的同步通道。StudyNext 0.3.0 因此继续使用
  “本地快照导入 + 用户手动登录官方页面”的安全方案。

## 1. 调研范围与方法

1. 检查超星开放平台入口：`https://open.chaoxing.com`、`https://open.chaoxing.com/oauth`。
2. 检查 `https://open.fanya.chaoxing.com` 及其 `/oauth` 路径。
3. 克隆并只读审查 `https://github.com/DanMo661/xuexitong-cli`（MIT）：
   commit `74b843ad4a3439a6ee5ba33f6a3288d9be6ed990`。
4. 对照本项目现有 `AuthorizedDataAdapter`、`ChaoxingAuthorizedAdapter`、
   `SyncService`、Portal 隔离层和 JSON 快照导入器。
5. 不执行刷课、签到、考试提交、验证码处理或任何写操作；不复制第三方项目代码。

## 2. 官方开放平台观察结果

| 地址                                    | 观察结果                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `https://open.chaoxing.com`             | 302 到 `passport2.chaoxing.com/login`，`refer` 指向 `open.chaoxing.com/op/toindex` |
| `https://open.chaoxing.com/oauth`       | 同样进入统一登录页；未显示公开 scope、应用注册或文档                               |
| `https://open.fanya.chaoxing.com`       | 落到 `super.fy.chaoxing.com/views/nonexistent.html?t=nounit3...`                   |
| `https://open.fanya.chaoxing.com/oauth` | 同上；未发现个人开发者自助入口                                                     |

公开页面没有给出可验证的 OAuth authorize/token 端点、scope 清单、回调域名规则、
个人开发者注册流程或数据授权范围。不能把登录跳转当作“已获得 OAuth 授权”。

**结论：** 若未来要接入实时课程/作业数据，需要超星或所在院校提供正式接口、
应用登记和授权范围；在此之前保持 `not_configured`。

## 3. `xuexitong-cli` 只读接口审查

该项目是 Python 只读工具，声明不签到、不刷课、不答题、不提交。其数据层可作为
“未来授权适配器”的字段和流程参考，但不能直接复制到 StudyNext，也不能把其中的
Cookie、密码处理或未公开接口当作官方 API。

| 能力     | 观察到的请求/解析方式                                                                             | 主要风险                            |
| -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 登录     | `POST passport2.chaoxing.com/fanyalogin`，表单密码 AES 加密；Cookie 持久化                        | 私有登录协议、验证码/风控、凭据安全 |
| 课程     | `GET mooc2-ans.chaoxing.com/.../courselistdata?courseType=1&courseFid=...`，解析课程 HTML         | 依赖登录 Cookie 与页面结构          |
| 课表     | `POST kb.chaoxing.com/pc/curriculum/getMyLessons`，按 `week` 取周课表                             | 周次、时区、节次映射易变            |
| 作业列表 | 从 `mooc1.chaoxing.com/visit/stucoursemiddle` 提取隐藏 `enc/openc/oldenc/workEnc`，再请求作业列表 | 参数来自页面隐藏字段，非公开 API    |
| 作业截止 | 逐份作业详情页解析“作答时间 ... 至 ...”                                                           | 请求次数多、页面文案变化会导致误判  |
| 章节     | `GET mooc2-ans.chaoxing.com/.../studentcourse`，解析章节树和任务点完成标记                        | HTML 结构耦合                       |
| 考试     | `GET mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist`                                 | 未公开接口，权限与频控不明          |
| 通知     | `POST notice.chaoxing.com/pc/notice/getNoticeList`，按游标分页                                    | 未公开接口，可能触发风控            |
| 课表缓存 | `curriculum.firstWeekDate` + `lessonTimeConfigArray` 组合真实日期/节次                            | 学期配置差异                        |

这些实现说明“技术上可以读取部分页面”，不等于“获得平台授权”。它们还存在：

- 账号密码进入第三方进程的风险；
- Cookie/Token 泄露、日志误记和本机持久化风险；
- 页面改版导致解析失败；
- 高频轮询触发风控或验证码；
- 无法保证数据完整性（例如截止时间解析失败时只能标记未知）。

## 4. StudyNext 的接入设计

### 4.1 已实现的安全边界

- 远程页面只运行在 `WebContentsView`：
  `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、
  `webviewTag: false`，不注入 preload，不暴露 `window.studynext`。
- 只允许 HTTPS 的 `chaoxing.com` / `xuexitong.com` 及其子域；
  校园 SSO 必须由用户显式加入 `trustedSsoDomains`，且仍要求 HTTPS、443 端口、
  无 userinfo，匹配精确域名或子域。
- 导航日志只记录 `safeDisplayUrl()` 处理后的地址：去掉 query、hash、userinfo；
  不记录 Cookie、Token、账号、密码或页面表单内容。
- 登录由用户在官方页面手动完成；应用只根据官方页面 URL 的路径做
  `unknown / logged_out / logged_in` 提示，不读取密码，不注入登录脚本。
- 未配置实时适配器时，同步状态固定为 `not_configured`；
  导入快照的来源固定为 `import`，界面显示“本地快照 · 非实时同步”。

### 4.2 授权适配器接口

`src/main/integrations/sync.ts` 中的 `AuthorizedDataAdapter` 是未来正式接入点：

```ts
interface AuthorizedDataAdapter {
  readonly id: string
  readonly displayName: string
  isConfigured(): boolean
  pull(): Promise<CourseBundle>
}
```

只有取得正式授权后，才可实现一个返回 `CourseBundle` 的适配器；
适配器输出先经过统一领域模型和 `upsertImportedTask()`，不能直接写数据库或渲染进程。

### 4.3 数据合并规则

- 课程、章节、学习点、任务使用稳定外部 ID；
- 同一外部 ID 重复导入时更新，而不是生成重复记录；
- 用户手动修改过的字段记录在 `manualFields`，后续导入保留该字段；
- 截止时间变化记录 `deadlineChanges` 并清理旧通知投递；
- 本地完成状态不会被平台返回值覆盖；
- 字段来源记录为 `manual / import / chaoxing / demo`，界面不混淆来源。

## 5. 登录与校园 SSO 状态机

当前状态：

```text
unknown
  ├─ 官方 passport / login / cas 页面 → logged_out
  ├─ i.chaoxing.com/base 或 /visit → logged_in
  └─ 从 logged_out 跳回学习通官方域名 → logged_in（成功后启发式）
```

限制：这是页面级启发式，不是服务端身份校验；学习通改版、跨域 SSO 或登录页
嵌入方式变化都可能使状态不准确。真实账号验收必须由用户手动完成，不能自动填入
账号密码；失败时展示“未登录/需要手动登录”，不把打开页面当作同步成功。

## 6. 实施阶段

| 阶段 | 内容                                                | 状态               |
| ---- | --------------------------------------------------- | ------------------ |
| P0   | 本地快照导入、外部 ID、增量更新、手动字段保护       | 0.3.0 已实现       |
| P1   | Portal 隔离、手动登录、SSO 域名白名单、导航日志脱敏 | 0.3.0 已实现       |
| P2   | 真实 OAuth 适配器、课程/作业/考试只读同步           | 需正式授权，未实现 |
| P3   | 系统级计划通知、后台同步、跨设备                    | 未实现             |

## 7. 真实账号回归清单（不记录凭据）

- [ ] 用户在官方登录页手动登录，应用只显示状态变化；
- [ ] 登录成功后能返回入口页，不出现白名单误拦截；
- [ ] 登录失败/取消后显示 `logged_out`，可重新尝试；
- [ ] 校园 SSO 域名只有用户显式保存后才允许导航；
- [ ] 导航日志不含 query、fragment、Cookie、Token、账号或密码；
- [ ] 关闭并重开 Portal 后会话仍由 Electron partition 管理；
- [ ] 清理会话后旧登录态不再显示为已登录；
- [ ] 无网络、DNS 失败、证书失败均显示错误而不是“同步成功”；
- [ ] 任何数据写入都必须经过显式导入或未来的授权适配器。

## 8. 不可声称的能力

- 没有官方 OAuth 授权，不得声称“已连接学习通账号”或“实时同步成功”；
- 不实现自动刷课、伪造签到、自动考试答题、验证码绕过、反爬规避；
- 不把 `xuexitong-cli` 的私有接口调用复制进生产代码；
- 不把本地 JSON 快照包装成平台实时数据；
- 不保证学习通页面结构长期不变。
