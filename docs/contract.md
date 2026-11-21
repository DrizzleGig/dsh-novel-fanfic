# dsh-novel-fanfic 服务契约（v0.2.0）

> 上游：[五插件协作契约 v1.1（正文 v1.2）](../../docs/小说插件系列-五插件协作契约-v1.1.md) §2 / §3 / §4 / §6
> 本文件只声明 **fanfic 自己**履约了什么、返回什么形状、哪些字段是派生数据。
> 冻结项（改 = major）：服务 key `novelFanfic`、数据目录 `.dsh-novel-fanfic/`、工具前缀 `fic_`、命令 `/fic`、右栏 tab kind `fanfic`。

---

## 1. 履约检查表

- [x] `ctx.provide('novelFanfic', api)` 标准形式；`ctx.get('novelFanfic')` 可读（`test/service.test.mjs`）
- [x] `identity()` 是**可调用函数**，字段齐全，`version` 与 `package.json` 一致
- [x] 所有服务方法只读；`lib/service.mjs` 里没有任何 `save*` / `import` / `waive`
- [x] 第一参数是**绝对** `cwd`；相对路径返回 `failed / BAD_DIR`，不 resolve、不回落 `process.cwd()`
- [x] `revision` 单调递增；`getContract` 带 `revision` 与 `generated_at`
- [x] 缺项目 / 缺原著 / 缺章返回 `status:'skipped'` + `code`，不抛异常
- [x] **永不读夹具**：内部只走 `loadProject` / `loadProjectCanon`（`source:'canon'`）
- [x] 事件只传 `{project, revision, at, kind}`，不传业务内容
- [x] 不 import 任何兄弟插件；只读 `.dsh-novel-beat/<book>/book.json` 一个文件
- [x] 未安装 conductor / beat / fade / voice 时行为与 v0.1 完全一致
- [x] 写操作（工具 / 命令）返回值带写后 `revision`

---

## 2. 服务方法

```js
ctx.provide('novelFanfic', api)   // service_version: 1, readOnly: true

api.identity() → {
  plugin: 'dsh-novel-fanfic',
  version: '0.2.0',
  service_version: 1,
  capabilities: ['fanfic.contract', 'fanfic.canon', 'fanfic.status', 'fanfic.revision'],
  dir: '.dsh-novel-fanfic',
  readOnly: true,
}
```

### 2.1 公共信封

四个数据方法都返回契约 §3.1 的信封（beat/fade/voice 返回裸对象，conductor 的适配层各自吸收）：

```jsonc
{
  "status": "ok | skipped | failed",
  "code": null | "NO_PROJECT | PROJECT_AMBIGUOUS | NO_SOURCE | NO_CANON | NO_CHAPTER | BAD_DIR | BAD_CHAPTER | MISSING_CWD | INTERNAL",
  "message": "人话",
  "data": { },
  "source": { "plugin": "fanfic", "cwd": "…", "project": "…", "revision": 17, "generated_at": "…", "stale": false }
}
```

- `status` **只描述这次调用有没有成功**，不描述内容结论（内容结论在 `fic_check` 的 `pass`）。
- `skipped` 表示「这件事现在不适用」：没项目、没导入原著、没有这一章——**不等于失败，也不等于完成**。

### 2.2 方法

| 方法 | 参数 | `data` 要点 |
|---|---|---|
| `getStatus` | `{cwd, project?}` | `project, revision, revisionDrift, imported, chapters, chars, buckets{characters/facts/worldRules/secrets/addresses → {confirmed,total}}, contradictions{open,total}, pending, deltas{premise,items}, declarations{auRules,headcanon,typos}, exportsForbidden, exportsRevised` |
| `getRevision` | `{cwd, project?}` | `project, revision, updatedAt, revisionDrift` |
| `getContract` | `{cwd, project?, chapter}` | `chapter, scene, markdown, chars, hash, **sections**, sectionOrder, revision, generated_at` |
| `getCanonSummary` | `{cwd, project?}` | `buckets, contradictions, revision` |
| `onDidChange` | `cb` | 订阅 `{project, revision, at, kind}`，返回退订函数 |

**`project` 可省略**，但只在工作区下**恰好一个**同人项目时自动选中；多于一个返回 `PROJECT_AMBIGUOUS` 并列出候选——不猜，避免串书。

### 2.3 `sections` 与 `markdown` 同源

`sections` 就是编译器内部的 `tags`，`markdown` 由同一份 `tags` 渲染：

```text
# 场景契约 ch002（sc_002）
> 任务卡：有　4 个节拍　1 项开放　目标「…」      ← 只有存在任务卡时才有这一行
【本作】…                                        ← 只有存在本作设定时才有这一段
【视角】…  【在场】…  【称呼】…  【知情】…  【世界规则】…
【时间线】…  【禁忌】…  【不确定】…  【锚点】…
```

因此校验方式是**逐字包含**：对 `sectionOrder` 里的每个 `tag`，`markdown` 必须包含 `【tag】sections[tag]`。
不要用 trim 相等冒充字节相等。

---

## 3. 工具返回（conductor 用 `tools/result` 收据读）

工具返回值 = `{ ok, text, ...结构化字段 }`：`text` 给模型读，结构化字段给 conductor 判。

| 工具 | 结构化字段 |
|---|---|
| `fic_contract` | `status:'completed'`, `chapter`, `scene`, `chars`, `hash`, `sections`, `sectionOrder`, `revision`, `source` |
| `fic_check` | `status:'completed'`, **`pass`**, `chapter`, `scene`, `revision`, `source`, `summary{blockers,warnings,infos,suppressed,waived,gateFindings}`, `findings[]`, `suppressed[]`, `waived[]` |
| `fic_plan` | `status:'completed'`, `chapter`, `mission`, `hasMission`, `revision` |

**`status` 与 `pass` 必须分开**：检查出 blocker 时 `status` 仍是 `completed`、`pass` 是 `false`。
conductor 的 `verify` 只认 `pass === true`。

### 3.1 waiver 在服务端应用

`fic_check` 在计算 `pass` 之前，先把 `waivers.json` 里匹配的记录应用掉（同章 + 同 detector + 同 code + 引文一致）。被放过的 finding 进 `waived[]` 并带 `waivedBy{id, reason}`，**不计入 pass**。
v0.1 只在面板里过滤，导致「作者放过了、conductor 还判失败」，v0.2.0 统一了这条口径。

---

## 4. revision 语义

- 存储：`project.json.revision`（整数，从 0 开始）。
- 唯一提交点：`commitProject()`（`lib/canon-store.mjs`）。每次调用 `+1`，并可选刷新 `exports`。
- 触发写入的 5 处：

| # | 写入口 | 场景 |
|---|---|---|
| 1 | `saveCanon` 之后的 `commitWrite` | 确认/拒绝提案、裁决矛盾 |
| 2 | `saveDeltas` 之后的 `commitWrite` | 改前提、加/删本作改动 |
| 3 | `saveDeclarations` 之后的 `commitWrite` | 加/删 AU 规则、私设句、错名 |
| 4 | `addWaiver` / `removeWaiver` | 忽略 / 撤销忽略一条 finding |
| 5 | `ingestFile` | 导入原著、重新分章 |

另有 `saveMission`（章节任务卡）走 `commitWrite`，同样 `+1`——任务卡会改变契约的「不确定」段。

- 迁移：旧项目读到无 `revision` → 按 `audit.jsonl` 行数**只在内存**兜底并标 `revisionDrift:true`；第一次真实写入落盘成权威值。
- 只增不减：删除也是一次写入。

---

## 5. 事件

```js
api.onDidChange(({ project, revision, at, kind }) => {…})   // kind: canon | deltas | declarations | waiver | mission | source
```

先落盘、后发事件；失败不发；订阅方抛错不回滚、不重放；事件不带业务内容。

---

## 6. 派生导出块（给 voice 读）

`project.json.exports`：

```jsonc
{
  "schemaVersion": 1,
  "revision": 17,
  "generatedAt": "2026-11-21T…",
  "forbidden": ["回魂", "亡者的声音", "沈研"],
  "addresses": [{ "from": "裴照", "to": "沈砚", "form": "阿砚", "public": "沈砚",
                  "private": "阿砚", "fromChapter": "ch002", "taboo": [] }]
}
```

- `forbidden` 来自作者私设的 AU 签名 + 错名（≤30 条，每条 2–30 字）——voice 递归找 `forbidden` 这类键时能直接读到。
- `addresses` 上限 60 条，**用姓名不用内部 id**。
- 这是派生数据，随时可从 canon + declarations 重建；`exports.revision === project.revision`，不一致说明导出过期（`getStatus.revisionDrift` 会提示）。

---

## 7. 只读边界

fanfic **读**兄弟插件的只有一处：`.dsh-novel-beat/<book>/book.json` 的 `decisions` 摘要（面板用；beat 缺席时整块不显示）。
fanfic **不写**任何兄弟账本，不 import 兄弟代码，不订阅兄弟事件。

---

## 8. 版本兼容

- `service_version` 整数；新增可选字段/能力 = minor，删除/改语义 = major。
- 新参数全部可选；旧的 `/fic` 子命令与 `fic_*` 工具参数一律保留。
- 旧项目（无 `schemaVersion`/`revision`/`exports`）读得动；首次写入自动补。
- `fic_contract` 的**人类可读文本**在「没有任务卡、没有新增段」时与 v0.1 逐字相同。
