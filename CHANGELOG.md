# CHANGELOG

## 0.4.2 — 2026-11-26

### 已知问题（P2/P3，发布后下个补丁处理）

- `media.json` / `avatars.json` 仍无跨进程锁；同一本书必须按 `COEXIST.md` 的单写流程使用，同进程并发写可能 last-writer-wins。
- 红果 WASM 的返回字段未做独立运行时 schema 校验；只信任 vendored 库，方法白名单仍限制为四个只读方法。
- 分格默认按“上→下、左→右”排列；竖排右→左/跨页漫画的 OCR 文本顺序可能错误。
- 真实 DSH 宿主截图、真实商业漫画页金标尚未跑；0.6.0 游戏解包不属于本版。

### 新增：`fic_analyze`

- `lib/analysis.mjs`：从已确认 canon 生成可回查 Markdown：`overview`（总览/覆盖）、`relations`（称呼/关系）、`timeline`（事件/伏笔）、`au`（本作改动影响面）、`reader`（读者假设）。pending 不算事实；推断/假设单独标注；分析视图用完整 canon（不按侧栏截断）。
- 第 8 个工具 `fic_analyze`；OOC 逐句检查仍走 `fic_check`，不重复造检查器。
- `test/analysis.test.mjs` 6 例；全量 231/231。
- 客户端「剧情 → 分析」视图：总览/关系/时间线/AU/读者五类报告卡；只读 canon；支持导出 Markdown；全量 231/231。
- 尚未做：分析报告导出/证据跳转、真实项目报告验收；AU 仅按人物名/别名确定性匹配。

## 0.4.1 — 2026-11-26

### 新增：红果短剧只读元数据

- vendored `openhongguo@0.4.1` WASM（Apache-2.0 + GO_LICENSE，`lib/vendor/openhongguo/`，约 5.26MB）；不依赖外部项目/CLI。
- `lib/hongguo.mjs`：只暴露 `search/getSeries/listEpisodes/listDanmaku`，**不暴露 `resolvePlayback`**，不取播放地址/内容密钥；设备档案放内存。
- `fic_source` 新增 `hongguo_search / hongguo_series / hongguo_episodes / hongguo_danmaku` 四个只读 action。
- `test/hongguo.test.mjs` 2 例（白名单/缺方法）；全量 201/201。
- 许可：`lib/vendor/manifest.json`、`THIRD_PARTY_NOTICES.md`、`scripts/check-licenses.mjs`；`npm run check:licenses` 通过（1 包/5 文件）。
- 真实实测：搜索“斗罗大陆”返回 6 条；某剧 53 集；首集 `第1集`；弹幕页可读（本集 0 条）。
- 尚未做：红果 UI/证据落盘、用户录屏抽帧、本地漫画读取。

### 新增：本地漫画 + Windows 内置 OCR

- `lib/windows-ocr.mjs` + `scripts/win-ocr.ps1`：调用 `Windows.Media.Ocr`，不装外部 OCR；真实中文截图 OCR 964 字通过。
- `lib/comic.mjs`：CBZ/ZIP（stored/deflate）解析、图片目录/单图、自然序、跳过非图片/路径穿越/加密/ZIP64；只对选中页 OCR，临时文件在系统 temp，完成后删除；单次 ≤30 页/30,000 字。
- `lib/image-gray.mjs` + `scripts/image-gray.ps1`：Windows 内置 System.Drawing 缩放读灰度；`lib/panel-detect.mjs` 纯 JS 投影分格；`comic_panels` 返回原图坐标。
- `lib/image-crop.mjs` + `scripts/image-crop.ps1`：Windows 内置裁剪；`ocrComicPanels` 先分格、逐格 OCR、按面板顺序拼文本；`comic_ocr` 增 `split:true`。
- `test/comic.test.mjs` 6 例、`test/windows-ocr.test.mjs` 3 例、`test/image-gray.test.mjs` 2 例、`test/panel-detect.test.mjs` 3 例、`test/image-crop.test.mjs` 2 例；金标合成漫画页（800×1200、2 格）整页 OCR + 分格 OCR 顺序通过；全量 231/231。
- `fic_source` 新增 `comic_list` / `comic_panels` / `comic_ocr` 三个只读 action。
- 尚未做：漫画 UI/证据落盘、PDF、红果 UI/证据、用户录屏抽帧。

### 新增：媒体来源/证据账本

- `lib/media.mjs`：项目 `media.json`，登记漫画/红果来源与最小证据；来源文件只存外部路径+hash，不复制整本/整集；不存播放地址/内容密钥。
- `mediaRevision` 独立于 `project.json.revision`；`fic_source` 新增 `media_list/media_add_comic/media_add_hongguo/media_add_evidence/media_remove`。
- `test/media.test.mjs` 3 例；全量 222/222。
- 尚未做：媒体证据 UI/verifier、分格/OCR 结果自动入证据、真实项目验收。

### 新增：媒体证据 verifier

- `verifyMediaEvidence`：漫画来源重算文件 hash、校验页码/格号；改文件/删文件标 stale；红果无本地源标 unverified；坏集号 invalid。
- `fic_source` 新增 `media_verify` 只读 action。
- `test/media.test.mjs` 增至 4 例；全量 223/223。
- 客户端新增一级导航「原著 / 漫画 / 红果 / 本作 / 剧情 / 写作」：漫画/红果独立成页，人物/势力/关系等仍是原著下位 chips；漫画支持粘贴路径 + 原生文件夹选择；红果按短剧名称搜索候选后登记；页面预览 + 分格框叠加 + 分集/弹幕 + 分析导出。尚未在真实宿主点测；全量 231/231。

## 0.4.0 — 2026-11-26

### 新增：人物形象资产存储层

- `lib/avatars.mjs`：`avatars.json` + `assets/avatars/` 的读写、哈希、魔数/尺寸/大小校验、原子写、`assetRevision`、`resolveAvatar`/`removeAvatar`/`avatarSummary`。
- 头像变更只 bump `avatars.json.assetRevision`，不 bump `project.json.revision`；图片不进 canon、不进契约。
- `test/avatars.test.mjs` 7 例：写入/解析/替换/删除/stale/坏图/路径穿越/越界 file/缺项目。
- `lib/avatar-sources.mjs`：Bangumi / AniList / Kitsu 作品与角色适配，Bing / 百度网页图解析；`searchWorks` 聚合、`listCharacters`、`searchWebImages`、`matchCharacters`；测试注入 fetch，不联网。
- `test/avatar-sources.test.mjs` 8 例；`novelFanficPanel` 增 `getAvatar`/`avatar` 两个 remote（14 方法），`avatar` 支持 `status/search_works/list_characters/match/web_search/fetch_image/set/remove`；set/remove 强制 `confirm:true`。
- `lib/avatar-fetch.mjs`：图片下载 allowlist/redirect:error/类型/大小/魔数校验；`test/avatar-fetch.test.mjs` 3 例。
- 新增第 7 个工具 `fic_avatar`（同 action 集合；模型可查/列/匹配/取图，写仍需作者 confirm；不返回二进制）。
- 客户端首版：`CharacterAvatar` 懒加载已确认头像并回退字母块；人物卡 44px、详情 64px；`AvatarSheet` 支持网页搜图（百度/Bing）、官方匹配（作品 → 角色 → 匹配 → 取图）、上传本地图居中裁 256×256、删除本地形象；`BatchAvatarSheet` 支持项目级作品搜索 → 全角色 high/medium 候选 → 逐项勾选 → 批量取图/裁剪/保存。真实宿主截图未做。
- `test/avatar-batch.test.mjs`：20 角色、18 确认（90%）、2 回退、匹配不串人。全量 225/225。
- 真实来源补测：Bangumi `3425` 火影忍者 241 角色/237 有图，抓取前 20 张官方 jpeg（98×300～450×600）；居中裁剪 → `setAvatar` 20/20 confirmed、`resolveAvatar` 20/20、assetRevision 20；文件在 tmp，未进仓库/npm。全量 231/231（含 0.4.1/0.4.2 的 32 例）。

## 0.2.3 — 2026-11-22

### 修复：面板读取会往对话里写「fic」命令行

- **现象**：打开或刷新右栏「同人」面板，对话时间线多出一行 `fic` 命令卡；一个会话累计 51 行。刷新一次写 4 条事件，保存任务卡最多 10 条。
- **根因**：客户端用 `ctx.remote.commands.execute('/fic panel --json')` 取数，而 DSH 的 `commands.execute()` 每次都会把 `command/run` + `command/done` 追加进会话日志（`@deepseek-ai/dsh-commands` 源码注释明确）。
- **修复**：新增 `novelFanficPanel` typert remote（12 个只读方法），Host 半 `novelFanficPanelView` 与 `/fic` 命令**共用同一个 handler**，进程内调用、不经过命令通道。客户端读操作全部改走 remote；写操作（`on/off`、`plan set/clear`、`confirm/reject/resolve`、`import`、`waive/declare/delta`）保留命令。
- **兼容**：新 client + 旧 Host 明确报「面板读接口未就绪，请更新并重载 DSH」，不会静默退回读命令；旧 client + 新 Host 仍按旧命令路径工作（需要刷新客户端才不再写行）。

### 修复：`/fic search` 把 `--limit` 的取值拼进搜索词

- `/fic search 阿砚 --json --limit 20` 实际搜的是「阿砚 20」。命令行参数解析排除了 `--limit` 的取值；面板改走 remote，直接传 `{ term, limit }`。

### 修复：确认 / 拒绝 / 裁决未显式传项目

- 三个写操作现在都带当前已解析的项目，不再依赖全局「当前项目」偏好；多项目并行时不会写错项目。

### 修复：保存任务卡重复刷新

- `planSet` 内部与外层 `run()` 各刷新一次；去掉内部那次，一次保存只刷新一轮。

### 测试

- `node --test` **179/179**（新增 `test/panel-remote.test.mjs`：Host 提供 view、契约 12 方法、客户端不再拼读命令；`test/client.test.mjs` 重写为「读走 remote、写走命令」）。

## 0.2.2 — 2026-11-21

- 接管：工具门改成 `effectiveOn = 装了故事总控 ? conductor.isDriving : /fic on`；总控关着时同人工具不可用，开着时可用。
- `/fic` 状态文案：可用 / 不可用 + 独立开关 + 故事总控开/关说明。
- 新增 `lib/tool-schema.mjs` 与 `test/tool-schema.test.mjs`（参数 schema 守卫，0.2.0 的 400 回归用例）。
- 文档：README 顶部补 v0.2.1 的 400 修复说明与 v0.2.2 行为。


## v0.2.1（2026-11-21）

### 修复：开启同人工作室后，DSH 里每条消息都返回 400

- **现象**：装 0.2.0 并执行 `/fic on` 之后，会话里每条消息都失败：
  `Invalid schema for function 'fic_plan': {"type":"string","description":"…"} is not of type "string"`
  （`INVALID_REQUEST` / status 400）。`/fic on` 会把选择写进 `prefs.json`，**重启后每个新会话都会中招**，
  与是否在写同人无关；`/fic off` 只对当前进程生效，必须重启 DSH 才恢复。
- **根因**：六个 `fic_*` 工具把插件内部的「参数名 → 描述对象」表直接交给了 `ctx.tools.register()`。
  这版 DSH 的 `register()` 收的是编译好的 JSON Schema（简写只对 `defineTool()` 生效），宿主原样透传给模型接口；
  `fic_plan` 新增的参数名 `title` 是 JSON Schema 的注解关键字（值必须是字符串），整份工具定义因此被拒。
  0.1.0 是同样的写法，但没有参数名踩到保留字，所以只是「模型看不到参数说明」，不会 400。
- **修复**：`index.js` 新增 `parameterSchema()`，六个工具统一编译成
  `{type:'object', properties, required:[参数名]}`；新增两条回归用例（完整 JSON Schema、参数表不得顶到 schema 根）。
- **验证**：`node --test` 172/172；`npm run check`；用 DSH 安装包自带的 `assertSupportedJsonSchema`
  逐个验证 6 个工具的 `parameters` 与 `output.schema`，6/6 通过。
- **影响面**：只改工具定义的形状，不动 canon / 契约 / 面板 / 存储格式；已导入的项目不需要迁移。

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
