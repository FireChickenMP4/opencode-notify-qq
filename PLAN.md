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

已验证：`--check` 拿到 token、网关连接成功（READY 收到）、QQ 实际收到消息。

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

1. **远程审批**（本次）—— 最刚需
2. 每轮总结
3. `.task` / `.ask` / `.stop` / `.restart`

---

## 5. 与姊妹项目的关系

| 项目 | 通道 | 场景 |
|---|---|---|
| opencode-notify-win | Windows Toast | 人在电脑前，切了窗口 |
| **opencode-notify-qq** | QQ | 人不在电脑前 |

两者独立，可同时装。
