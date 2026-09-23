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

## 4. 后续：`.task` 指派任务（未实现）

设想：用 `.task` 开头的消息给 agent 派活。

### 4.1 必须解决的并发问题

**多个 opencode 同时开 → WSS 会冲突。** 所以不能每个 opencode 各连一条。

### 4.2 建议架构

```text
                  唯一 WSS 连接
QQ 用户 ──消息──> [qqbot daemon]        （独立进程，单例）
                       │
                       ├─ 写入队列目录 / 本地 socket / 命名管道
                       │
        ┌──────────────┼──────────────┐
   opencode A      opencode B      opencode C
   （读队列，不持有 WS）
```

要点：

- **daemon 是单例**，持有唯一 WSS 连接，负责 Identify/心跳/Resume
- opencode 侧**永不持有 WSS**，只从队列取消息
- 队列可选：文件目录（最简单）、本地 TCP/Unix socket、SQLite
- 需要一个"已领取/处理中"标记，避免两个 opencode 抢同一条

### 4.3 待定问题

- **派给谁**：消息如何路由到特定 opencode 会话？需要 `cwd` / 项目 / 显式 tag
- **回复**：结果发回 QQ 需要拿到原消息的 `msg_id`（被动回复才有窗口）
- **权限**：`.task` 意味着远程执行，要有白名单与确认机制
- **幂等**：断线重连会补发事件（Resume），去重靠 `event.id`

### 4.4 不做的话

如果最终不做 daemon，也可以只在**单会话**下用：启动时独占 WSS，退出时释放。代价是同时只能开一个 opencode 收任务。

---

## 5. 与姊妹项目的关系

| 项目 | 通道 | 场景 |
|---|---|---|
| opencode-notify-win | Windows Toast | 人在电脑前，切了窗口 |
| **opencode-notify-qq** | QQ | 人不在电脑前 |

两者独立，可同时装。
