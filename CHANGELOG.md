# CHANGELOG

## v0.2.0（2026-11-21）

### 新增：只读服务 `novelFanfic`

- `ctx.provide('novelFanfic', api)`，`service_version: 1`，`readOnly: true`。
- 方法：`identity()` / `getStatus({cwd, project})` / `getRevision({cwd, project})` /
  `getContract({cwd, project, chapter})` / `getCanonSummary({cwd, project})` / `onDidChange(cb)`。
- 返回公共信封 `{status, code, message, data, source}`：`status` 只说这次调用成没成，
  内容结论在 `fic_check` 的 `pass`。
- 硬规则：第一参数是**绝对 cwd**；**永不读夹具**；revision 与内容来自同一次读盘；没有写方法。
- 项目寻址：`project` 可省略，但只在工作区下恰好一个同人项目时自动选中，多于一个报
  `PROJECT_AMBIGUOUS`（不猜、不串书）。

### 新增：`project.json` 的 schemaVersion / revision / exports

- `revision`：任意一次改变账本内容的写操作 +1。五个写入口共用唯一的提交点
  `commitProject()`：确认/裁决提案、本作改动、作者私设、忽略/撤销忽略、导入原著（+ 任务卡）。
- 旧项目没有 `revision` 时按 `audit.jsonl` 行数**只在内存**兜底并标 `revisionDrift`，
  第一次真实写入落盘成权威值。
- `exports`：派生导出块（`forbidden` 禁忌词 + `addresses` 称呼表，用姓名不用内部 id），
  让 voice 的 `loadContract()` 真正读到东西——v0.2.0 之前那条边「路径通了、数据还是没有」。
- `onDidChange`：先落盘后发事件，只传 `{project, revision, at, kind}`。

### 新增：章节任务卡（`fic_plan`）

- 新工具 `fic_plan`（`get` / `set` / `clear`）与新命令 `/fic plan list|get|set|clear`。
- 落盘 `<项目>/project/chapters/<章>/mission.json`：目标 / 情绪曲线 / 节拍（≤7）/
  原著锚点 / 读者期待 / 避开 / 开放问题 / 目标字数 / 状态 / canonRefs。
- 唯一进契约的地方：「开放问题」注入契约的「不确定」段；有任务卡时契约多一行
  `> 任务卡：有　N 个节拍　M 项开放`。没有任务卡时契约输出与 v0.1 逐字相同。
- 任务卡不是 canon、不是契约、不是 beat 的决策账本；删掉不影响编译。

### 变更：结构化返回

- `fic_contract` 除 `text` 外返回 `status / chapter / scene / chars / hash / sections / sectionOrder / revision / source`。
  `sections` 就是编译器内部的 `tags`，`markdown` 由同一份 `tags` 渲染，所以「段之和 = 全文」天然成立。
- `fic_check` 除 `text` 外返回 `status / pass / revision / summary / findings / suppressed / waived`。
  **执行成功（`status:'completed'`）与检查通过（`pass`）分开**；conductor 的 verify 只认 `pass === true`。
- **waiver 改到服务端应用**：v0.1 只在面板里过滤，导致「作者放过了、`/fic check` 与 conductor 还判失败」。
  现在先应用 waiver 再算 `pass`，被放过的 finding 进 `waived[]` 并带理由。

### 变更：面板重设计

- 一级入口从「总览 / 设定 / 剧情 / 原文」改为**原著 / 本作 / 剧情 / 写作**（各带计数）。
  「总览」不再是一级入口，改成顶部常驻的**一行「下一步」**（7 种状态，一句话 + 一个主按钮）。
- 设定下的左侧竖排六项改成**横向 chips**（人物 / 势力 / 关系 / 世界 / 冲突 / 原文）。
- 右下「写作准备」浮动按钮**删除**（它压住了内容），写作准备升成「写作」区：
  章选择 + 章节任务卡 + 契约 + 写完之后。
- 审阅收成**唯一入口**：顶栏「待办 N」→ 审阅 sheet（待确认 / 设定矛盾）。
- 视觉：新增 `--fic-*` token 层（映射到宿主 `--dsw-alias-*`，深色跟随宿主），
  去掉人物卡上不承载信息的彩色渐变顶边，卡片标题/正文/元数据统一字阶。
- 「本作」区补上**被放过的检查**（可撤销）与作者私设入口。

### 新增：只读 beat 摘要

- 面板的「写作」区显示 `《书名》：已拍板 N 条，待拍板 M 条`，读 `.dsh-novel-beat/<book>/book.json`，
  不 import、不写、不订阅；beat 缺席时整块不显示。

### 文档

- 新增 `docs/contract.md`（履约检查表、方法表、revision 语义、事件、导出块、只读边界）。

### 兼容

- 旧的 `/fic` 子命令与 `fic_*` 工具参数全部保留；旧项目读得动；`fic_contract` 的人类可读文本在
  没有任务卡时与 v0.1 逐字相同。

### 未做（明确）

- `lib/remote.js`（typed remote，替掉面板拼 slash 命令）推迟：它改的是数据通路，风险最高，
  放到 0.2.1 单独做，并保留 slash 兜底。
- 粉丝雷达、故事实验室、试读反馈、发布包、EPUB/PDF、关系图、语义检索：按方案排到 0.3 以后。

## v0.1.0

首个公开版本：导入原著 → canon 资料库 → 场景契约 → 确定性检查 → 原文检索；侧边栏 4 区面板。
