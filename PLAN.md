# PLAN

设计取舍与后续规划。

---

## 1. 范围

**当前版本只做通知**：让 opencode 里的 agent 能把消息推到 QQ。

明确**不做**：接收任务、事件 hook、多用户。这些记在 §4。

---

## 2. 关键设计决策

### 2.1 工具，不是事件 hook

| 方案 | 触发 | 判断者 |
|---|---|---|
| event hook | 会话事件（`session.idle`） | 代码 |
| **tool（本方案）** | agent 主动调用 | **模型** |

选 tool 的原因：

- 需求是"**让 agent 在 QQ 上通知我**"，判断权应该在 agent。
- 会话结束 ≠ 需要通知（短问答不需要）。hook 会噪声化。
- tool 不依赖"进程重启后 hook 才生效"这类时序问题，可即时验证。

### 2.2 官方 Bot，不是无头个人号

| 方案 | 合规 | 风险 |
|---|---|---|
| **QQ 官方 Bot**（本方案） | 是 | 无 |
| NapCat / Lagrange（模拟个人客户端） | 否 | 违反 QQ 用户协议，封号风险；且 NapCat 明确禁止未授权拆用其代码 |

官方 Bot 的限制（主动消息窗口）是**协议内的正常约束**，可接受。

### 2.3 配置外置

密钥放在 `~/.config/opencode/notify-qq.json`，**不进仓库**。

- 与 opencode 自身的凭证管理习惯一致（`auth.json` 也在 `~/.local/share/opencode/`）
- 仓库可公开
- 支持 `NOTIFY_QQ_CONFIG` 覆盖路径

### 2.4 发送用 REST，接收才是 WSS

这是**多开安全**的核心：

```text
发消息  -> POST /v2/users/{openid}/messages   （无状态，多开不冲突）
收消息  -> WSS 网关长连接                      （有状态，同 shard 多开会互踢）
```

实测：网关 `session_start_limit` 限制并发连接；相同 `shard` 重复 Identify 会触发
`op 9 Invalid Session`，旧连接被断开。**所以收消息的进程只能有一个。**

---

## 3. 现状

- [x] 配置层（`src/config.ts`）
- [x] QQ 客户端（`src/qqbot.ts`）：token 缓存/刷新、REST 发送、WSS 连接（Hello/Identify/Heartbeat/Resume）
- [x] CLI（`src/notify.ts`）：`--check` / 发送
- [x] 有界监听（`src/listen.ts`）：抓 openid、调试事件
- [x] plugin（`plugins/notify-qq.ts`）：注册 `notify_qq` 工具
- [x] 安装脚本（`install.ps1`）
- [x] **bridge 远程审批**（SSE + QQ，单例锁端口 + 插件自动拉起）
- [x] **子代理结束默认不通知**（带标题，`OPENCODE_NOTIFY_SUBAGENT=1` 开启）
- [x] **回合结束带本轮总结**（读 transcript 的最后一段助手文本，不额外调模型）
- [x] **指令集** `.task` / `.ask` / `.stop` / `.restart`

已验证：token、网关连接、QQ 收发、真实权限请求的 `once/always/reject`、
`delivery=queue/steer`、`abort`、单例锁拒绝第二个 bridge。

---

## 4. 远程控制（设计）

### 4.1 关键发现：opencode 有完整 HTTP API

实测 `opencode serve`（1.18.32）确认，控制面**不需要 plugin 收发**：

| 能力 | 端点 |
|---|---|
| 订阅事件（SSE） | `GET /event` |
| 发消息 | `POST /session/{id}/message`（支持 `delivery: steer\|queue`） |
| 中断 | `POST /session/{id}/abort` |
| **审批回复** | `POST /permission/{requestID}/reply` `{"reply":"once"\|"always"\|"reject"}` |
| 待审批列表 | `GET /permission` |
| 已存权限 | `GET/POST/DELETE /api/permission/saved` |
| 会话列表 | `GET /session`（`Session.directory` 给出工作区） |

`once` / `always` / `reject` 三种回复与预期完全一致。

> 版本注意：已装 SDK 1.15.13，二进制 1.18.32。以运行中 server 的 `/doc` 为准；
> 优先用 v1 路由（`/session/...`、`/permission/...`、`/event`），两版都有。

### 4.2 架构：单 server + bridge（选 B）

采用 **B：`opencode serve` + `opencode attach`** —— 一个 server 进程承载所有 TUI，
plugin 只有一个实例，**没有多实例聚合问题**。

```text
QQ 用户 ──WSS(唯一)──> [bridge]  （独立进程，单例）
                          │
                          ├─ GET /event  (SSE) 订阅事件
                          ├─ GET /permission    待审批
                          └─ POST /permission/{id}/reply   回复
                                     │
                              opencode serve (127.0.0.1:P)
                                     ▲
                              opencode attach (多个 TUI)
```

**为什么不是每个 plugin 各连一条 WSS**：
- WSS 同 appId+shard 多开会互踢（见 §4.4）
- bridge 单例持有唯一连接，所有 opencode 通过 HTTP 与它交互
- plugin 的职责缩减为"**上报自己的 serverUrl**"（bridge 需要知道连哪）

### 4.3 远程审批（先做）

流程：

```text
permission.asked (SSE)
   → 取 Session.directory（哪个工作区）
   → 取 PermissionRequest：permission / patterns / metadata / always
   → QQ 消息：
       【需要授权】<工作区>
        工具: bash
        命令: rm -rf build
        o=once  a=always(记住)  r=reject
   → 用户回 o / a / r（大写也认）
   → POST /permission/{id}/reply
```

**缩写映射**（按用户要求，大小写都接受）：

| 输入 | 回复 | 含义 |
|---|---|---|
| `o` / `O` | `once` | 只批这一次 |
| `a` / `A` | `always` | 记住，之后同类不再问 |
| `r` / `R` | `reject` | 拒绝 |

**关于 reject 终止会话**：`reject` 是拒绝该权限请求，opencode 收到后会自行决定
后续（这不在我们的控制范围内）。用户选择 reject 后**自己再发 `.task` 继续**。

### 4.4 WSS 单例约束（为什么不每实例一条）

官方 `session_start_limit` 限制并发；同一 appId+shard 重复 Identify 触发
`op 9 Invalid Session`，旧连接被踢。**所以收消息的进程只能有一个** —— 这就是
bridge 必须单例的原因。

### 4.5 指令集（后续阶段）

| 指令 | 语义 | 阻塞性 |
|---|---|---|
| `.task <内容>` | 派任务，**queue 到本轮结束**（`delivery:"queue"`） | 排队 |
| `.ask <内容>` | 轻量插话（`delivery:"steer"`）；会话已结束时等同于 `.task` | 立即 |
| `.stop` | 中断当前执行（`POST /session/{id}/abort`），**最高优先级** | 立即 |
| `.restart` | 重启工作流 | — |

`.ask` 与 `.task` **只在阻塞性上有区别**：`.ask` 插话不打断当前回合，`.task`
排队等本轮结束；若会话已结束，二者效果相同。

### 4.6 每轮结束发送总结（后续阶段）

现在的空闲钩子只发固定文案 `opencode · 完成`。改进：让 agent **输出本轮总结**
再推送，而不是只报"完成"。实现要点待定（如何在事件回调里拿到本轮输出）。

### 4.7 安全

- bridge 绑定 `127.0.0.1`；若需外网，走隧道 + `OPENCODE_SERVER_PASSWORD`
- `.task` 意味着远程执行，需要**白名单 + 确认**
- 幂等：断线重连会补发事件（Resume），去重靠 `event.id`

### 4.8 分阶段

1. ~~远程审批~~ ✅
2. ~~每轮总结~~ ✅（读 transcript 最后一段助手文本，不调 `/summarize`）
3. ~~`.task` / `.ask` / `.stop` / `.restart`~~ ✅

### 4.9 指令细节

| 指令 | 端点 | 说明 |
|---|---|---|
| `.task <内容>` | `POST /api/session/{id}/prompt` `delivery:"queue"` | 排队，本轮结束后执行 |
| `.ask <内容>` | 同上 `delivery:"steer"` | 立即插话；会话空闲时与 `.task` 等效 |
| `.stop` | `POST /session/{id}/abort` | 中断当前执行 |
| `.restart` | `abort` + 发续跑 prompt | 重启工作流 |

**目标会话**：bridge 记录**最近一次见过的 sessionID**（从 permission 事件）。
多会话时若要显式指定，留待后续（加 `#<短id>` 前缀）。

---

## 5. 与姊妹项目的关系

| 项目 | 通道 | 场景 |
|---|---|---|
| opencode-notify-win | Windows Toast | 人在电脑前，切了窗口 |
| **opencode-notify-qq** | QQ | 人不在电脑前 |

两者独立，可同时装。


---

## V2 迁移（opencode 2.x）

本节只记录 V2 下与上文 V1 设计不同的地方；上文的 V1 记录保留作历史。

- **不再需要 `opencode serve` + `opencode attach`**。V2 有常驻后台服务，服务自己注册
  url + 密码（`~/.local/state/opencode/service.json`）；bridge 用 `@opencode/client` 的
  `Service.discover()` 找到它、`Service.headers()` 带 Basic 鉴权，断线重连时会重新发现
  （服务重启会换端口）。
- **接口替换**（V1 -> V2）：
  - `GET /session?limit=N` -> `session.list()`，响应是 `{data, cursor}`
  - `GET /session/{id}/message` -> `session.context({sessionID})`（消息是 tagged 的
    `{type, content}`，不再是 `{info, parts}`）
  - `POST /session/{id}/abort` -> `session.interrupt({sessionID})`
  - `POST /session/{id}/prompt_async` -> `session.prompt({sessionID, text})`
  - `GET /permission` -> `permission.request.list()`（`{location, data}`）
  - `POST /session/{id}/permissions/{req}` -> `permission.reply({sessionID, requestID, decision})`
    （注意字段名是 **`decision`**，值 `once` / `always` / `reject`）
- **`GET /session/status` 在 V2 不存在**。忙/闲改为：`session.step.started` 置忙、
  `session.step.ended` 且 `finish` 不是 `tool-calls` 置闲，再用 `session.active()` 兜底校准。
- **回合结束信号**：V2 的公开事件流里没有 `session.idle` / `session.status`，改用
  `session.step.ended` 的 `finish`。重试告警从 `status.type === "retry"` 改为
  `session.retry.scheduled`。
- **新增 QQ 指令 `.btw <问题>`**：调 `session.generate({sessionID, prompt})` 拿一次性回答，
  不写进对话也不打断回合。
- **`.task` 投递**仍是 bridge 自己排队、回合结束才送；`prompt` 不再显式传 agent
  （V2 里 agent 是会话属性）。**这一条未实测**，若 `.task` 不生效先看这里。
- **诊断**：`.stop` / `.task` / `.btw` / `.status` 的用法不变；`--check` 现在校验的是
  「服务发现 + 鉴权 + 待审批列表」。


### 命令结果回推（bot 语义）

.task / .ask 注入的那一轮结束时**一定**把结果推回 QQ，即使 wayNotify 关着：
命令的结果是「回复」，不是单向推送。实现：bridge 注入后写标记
（%TEMP%/opencode-notify/qq-command/<sessionID>），插件在回合结束时消费它并据此放行；
只有插件一侧发送，所以开关开着时也不会与自动推送重复（幂等）。标记带 TTL，
默认 6 小时，OPENCODE_NOTIFY_QQ_OUTCOME_TTL_MS 可调。


### 提问也是「需要回应」（新增 .answer）

question 工具在 V2 表现为 orm.created。它和审批一样需要你回应，所以同样不受
wayNotify 管：bridge 把题目与选项推给你，回 .answer <内容> 回答
（session.form.reply({sessionID, formID, answer})，nswer 是「字段 key -> 值」；
选项文字会映射成选项的 value，其他按自由文本发）。没有待回答的表单时该命令无效。
bridge 用 orm.created / orm.replied / orm.cancelled 维护待回答表，
并在命令前用 session.form.list({sessionID}) 剔除已失效的。


### .btw 的两个修正（实测反馈）

- **截断**：`session.generate` 不能用工具，模型想动手（查文件/网页）时文本会停在那儿。现在给旁问的
  prompt 加一句「不要使用任何工具、也不要提议去查阅」，并给答案的标题加上会话编号
  （`**opencode · 旁问 · #N**`）。
- **没有反馈**：一次模型调用要几秒，之前是干等；现在先回一条「旁问已发出 …，稍后回你」再回答案。

顺带记下官方口径（CLI 插件文档）：斜杠命令与快捷键由 **CLI 插件**（`@opencode/plugin/tui` 的
`context.keymap.layer({ commands: [{ bind, slash, palette, run }] })`）注册；服务端插件只能用
`ctx.command.transform` 注册命令（没有 bind）。命令是否打断回合由投递方式决定
（`session.prompt({ delivery: "steer" | "queue" })`），所以「不打断」两种入口都能做到。


### 带工具的旁问：.bt（新建）

`session.generate`（`.btw`）按定义用不了工具，所以「要读文件/查网页」的旁问只能换一种形态：
**不做记录的 fork**。

流程（全部实测）：

1. `session.fork({ sessionID })` —— 分支继承父会话的历史（实测 30/31 条）；父会话正在跑也不影响。
2. `session.update({ sessionID: fork, permissions: [...] })` —— V2 的 action 名是
   `read` / `glob` / `grep` / `webfetch` / `websearch` / `edit`（涵盖 write、patch）/ `shell`，
   **不是** V1 的 `write` / `bash`：名字写错会静默不匹配（默认策略是 `{"action":"*","effect":"allow"}`），
   看起来就像"权限没生效"。deny 是把工具从模型手里摘掉，而不是运行时拒绝。
   默认只读，配置 `asideTools: "full"` 可放开成普通回合的权限。
3. `session.prompt({ sessionID: fork, text })` 提问，然后轮询 `session.context()`：最后一条是
   assistant、`finish !== "tool-calls"`、且带 `time.completed` 才算答完（不依赖事件簿记，
   child 会话的事件不是必到）。
4. 取答案：`context()` 返回的**就是消息数组**（没有 `{ info, parts }` 包裹），part 在
   `msg.content` 里（不是 `parts`）。只看 fork 前缀之后的消息，否则可能把父会话自己的话当成答案。
5. `session.remove({ sessionID: fork })` —— 分支连同它的记录一起消失，主会话毫发无损。

实现要点：

- **必须 detached**：一轮带工具的问答要几十秒到几分钟，而网关是 `await runCommand` 串行的，
  会挡住 `.stop` 和审批回复；所以先 ack，再 `void runAside(...)`，错误在内部捕获并回推。
- fork 出来的会话 `parentID` 非空，通知插件按子代理处理，所以它结束**不会**弹窗/推送。
- `.bt` 只读时，如果答案要读工作区外的路径，会走 `external_directory` 的 `ask`（默认策略），
  也就是通过既有的审批推送来问你，行为与普通回合一致。
- 超时 `OPENCODE_NOTIFY_QQ_ASIDE_TIMEOUT_MS`（默认 300s），超时回一条「还没答完」。
- 成本：fork 继承上下文，一次 `.bt` 的输入 token 约等于父会话上下文 + 工具往返；只想省 token 用 `.btw`。


### .bt 首次真机测试暴露的两个 bug（已修）

第一次从 QQ 发 `.bt` 的结果是：ack 发出、fork 干了活（74 条消息）、**答案没回推**，而且
fork 抢走了会话编号（`.status` 显示成了 `#3`，`.ask #3` 真的打进了 fork）。

1. **结束判定认错**：会话记录的最后一条不是 assistant，而是 `{type:"idle", outcome:"succeeded|failed"}`
   （每轮末尾一条）。原来只认「最后一条是 assistant 且 finish !== "tool-calls"」，永远不成立 →
   一直等到 300s 超时才放弃。现在：`tail` 里出现 `idle` 即算结束（并保留 finish 检查作为兜底）。
   实测：57s 内正确判定。
2. **fork 没有 parentID**：`session.fork` 产生的会话 parentID 为空，所以对 bridge 与通知插件来说
   它就是一个全新的普通会话 —— 会拿编号、会抢「最近会话（默认目标）」，插件还会为它推一条
   「完成」。现在：`asideIds` 让 bridge 既不给编号、也不把它记为默认目标；fork 上写
   `metadata: { aside: true }` + 标题 `旁问 · …`，插件据此静默。

另外两个小改进：

- `.bt` 回复的标题固定带上目标会话编号 `#N`（aside 本身是临时的，不留编号，编号要取自目标会话）。
- `.bt` 的 ack 与答案都带 `[#N 目录]` 标签。


### 旁问的模式提示语 + .list（新增）

- 两个旁问的 prompt 现在都带一段固定「框架」：这是 QQ 旁问、答案直接推到手机、要结论不要派活；
  再按命令补一句能力边界（`.btw` 用不了工具 / `.bt` 在一个只读 fork 里），最后追加用户在配置里
  写的 `asidePrompt`（默认空）。
  起因：`.bt` 虽然是 fork、**继承上下文**，但模型并不知道自己处在旁问模式，容易把旁问当成
  「继续干活」（去改文件、跑命令、汇报下一步计划）。
- `.list`：列出 bridge 能寻址的会话（编号 + 目录 + 运行中/空闲 + 标题），按最近活动排序，
  默认最多 8 条（`OPENCODE_NOTIFY_QQ_LIST_LINES`）。用 `sessionNumbers.lookup()`（只读，
  不分配编号），所以显示的就是当前有效的编号。
- 新增测试：`formatList` 3 例、`parseCommand(.list)` 1 例、`asidePrompt` 解析 1 例。
