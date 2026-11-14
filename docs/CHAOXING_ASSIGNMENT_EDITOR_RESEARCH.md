# 学习通作业编辑器与附件协议研究

记录日期：2026-11-14
范围：只读研究 + 官方页面内操作验证；本轮不重写原生编辑器。

## 1. 已验证的作业页面结构

作业详情入口：

```
https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=...&classId=...&cpi=...&workId=...&answerId=...&enc=...
```

会跳转到 `.../mooc-ans/mooc2/work/dowork?...`。页面包含：

- 左侧作业说明与题目区；
- 右侧作答区，富文本编辑器为 UEditor；
- 底部“暂时保存”“提交”按钮。

编辑器实例的 textarea id 形如 `answer406079016`；页面内 UEditor iframe 为 `#ueditor_0`。编辑器内容通过 `UE.getEditor(<textarea id>).getContent()` 读取、`setContent(content, false)` + `ed.sync()` 写回。

注意：对 `ueditorInstant0` 这类实例再次调用 `UE.getEditor(...)` 会重新渲染并可能抛出 `Cannot read properties of null (reading 'style')`；应复用页面已有实例或以 textarea id 获取。

## 2. 附件上传协议

工具栏“附件”按钮打开 iframe 对话框：

```
https://mooc1.chaoxing.com/mooc-ans/mooc2/js/editor/dialogs/attachment_new/attachment.html
```

对话框内部使用 WebUploader：

- `input[type=file][name=file].webuploader-element-invisible`
- `#pickfiles`：上传文件
- `#pickfiles2`：上传更多
- 单文件上限 500MB（页面文案）

真实上传请求：

```
POST https://mooc1.chaoxing.com/upload-ans/ueditorupload/attachment?uploadtype=work&source=1&enc2=...&t=...&uid=...
```

返回 200 后对话框自动关闭，附件以 `attach-iframe` 形式插入编辑器内容：

```html
<iframe class="attach-iframe" objectid="df27ab47eac9fc4e34067e114909748a"
        filename="StudyNext-附件上传验证.txt" filesize="56B"></iframe>
```

已保存附件在详情页由 `insertCloud.html` 渲染；解析字段为 `objectid`、`filename`、`filesize`。

程序化 `input.click()` 在 Chromium 中触发：

```
File chooser dialog can only be shown with a user activation.
```

说明文件选择器请求已经到达 Chromium，仅因缺少用户手势被拦截，不是平台不支持上传。进一步用 CDP `Runtime.evaluate` 的 `userGesture: true` 直接点击 `input[type=file]`，收到 `Page.fileChooserOpened`（`mode: selectMultiple`，`backendNodeId` 有效），证明真实用户点击“附件”按钮会打开系统文件选择器；页面侧 WebUploader 会完成后续上传。上传成功后的附件以 `attach-iframe` 插入编辑器，`暂时保存` 后重新进入页面仍保留。

## 3. 保存与提交协议

- “暂时保存”调用 `saveWork()`，POST 到 `addStudentWorkNewWeb`，表单参数包含 `answer<textare aid>` 的富文本 HTML 与附件 `attach-iframe`。
- 成功返回：`{"msg":"保存成功！","status":true}`。
- “提交”先 `submitValidate()` GET `/work/validate`，再由 `confirmSubmitWork()` POST `addStudentWorkNewWeb`。
- 提交成功且返回 `data.stuStatus == 5` 时，页面提示成功并可能跳转 `data.backUrl`；否则进入 `/mooc-ans/mooc2/work/prompt?...` 步骤页。
- 平台可能拒绝空内容（`无效的参数：code-1`），也可能对已截止/已提交作业限制修改；必须把官方页面提示原样呈现给用户。

## 4. 题型与富文本

已确认的作答区域是 HTML 富文本，可承载：

- 纯文本、段落、加粗/颜色/字号等 UEditor 格式；
- 图片（工具栏“图片”“拍照上传”）；
- 附件（`attach-iframe`）；
- 数学公式/特殊符号（UEditor 插件，按页面实际工具栏为准）。

常见作业题型（平台通用，具体以课程页面为准）：单选题、多选题、填空题、判断题、简答题、论述题、计算题、材料题。不同题型的判分与作答控件不同，不建议用一个通用编辑器统一重写。

## 5. 渐进式原生化方案

1. **保持官方页面为主**：提交、暂存、附件上传继续在 WebContentsView 的官方页面完成，保证平台行为一致。
2. **原生只做辅助**：在任务详情提供“在内嵌页面打开”，由用户本人确认提交；应用只负责提交检测与状态回读。
3. **可选的本地草稿**：未来可将纯文本/HTML 草稿保存在本地 SQLite，一键填入官方编辑器；不替代官方暂存。
4. **复杂题型不动**：单选、多选、判断、公式、图片题继续使用官方页面，避免协议漂移。
5. **提交结果以平台回读为准**：不根据 POST 成功判断提交成功，必须重新读取作业详情页的 `平台状态`、`提交时间`、`成绩`、`教师批语`。

## 6. 本轮实现边界

- 已实现：附件解析入任务模型、任务详情附件列表、提交检测事件（`addStudentWorkNewWeb` POST 与 `/work/prompt` 页面双路检测）、提交后按课程重新同步。
- 未实现：原生富文本编辑器、原生附件上传 UI、原生提交按钮。
- 真实账号验证：附件上传、暂时保存、重进后保留均已通过；最终“提交”由用户本人点击，本轮未自动提交。提交检测与状态回读已用 `/work/prompt` 触发验证：事件回调收到 `platformCourseId=267068456`，随后“课程重试完成：程序设计基础，6 项作业、0 个章节、15 个资料”。
