# opencode-notify-qq

> 顺手 vibe 的

让 opencode 里的 agent 能主动往你的 QQ 推消息——你走开了也能被叫回来。

## 为什么

opencode 自带的通知依赖终端转义序列，**在 Windows Terminal 上不弹窗**（见姊妹项目 [opencode-notify-win](https://github.com/FireChickenMP4/opencode-notify-win)）。而「人不在电脑前」时，屏幕通知本来就没用——需要的是**推到手机**。

这个项目用 **QQ 官方机器人**（`bot.q.qq.com`）把消息推到你的 QQ。

## 它是什么（以及不是什么）

**是**：一个给 agent 用的 **工具**（`notify_qq`）。agent 判断"该通知了"（长任务结束、需要你拍板、你说过要出门）就调用它。

**不是**：事件 hook（"会话结束自动通知"）。那是另一条路，见 [PLAN.md](./PLAN.md) 的取舍说明。

## 要求

| 依赖 | 说明 |
|---|---|
| opencode | 近期版本 |
| Bun | 1.x（CLI 与类型检查） |
| QQ 机器人 | 在 [QQ 开放平台](https://q.qq.com/) 注册，拿到 AppID + AppSecret |
| 平台 | 任意（纯 HTTP/WSS，无平台绑定） |

## 安装

### 1. 配置凭据

创建 `~/.config/opencode/notify-qq.json`（Windows：`C:\Users\<你>\.config\opencode\notify-qq.json`）：

```json
{
  "qqbot": {
    "appId": "你的 AppID",
    "clientSecret": "你的 AppSecret",
    "sandbox": false,
    "notifyTarget": {
      "type": "c2c",
      "openid": "你的 openid"
    }
  },
  "awayNotify": {
    "enabled": false
  },
  "asideTools": "guarded",
  "asideAgent": "build"
}
```

| 字段 | 说明 |
|---|---|
| `appId` / `clientSecret` | 开放平台管理端获得 |
| `sandbox` | 沙箱环境填 `true`（域名与凭据都不同） |
| `notifyTarget.type` | `c2c`（单聊）或 `group`（群聊） |
| `notifyTarget.openid` | `c2c` 用；`group` 时改用 `groupOpenid` |
| `awayNotify.enabled` | 回合结束时**自动**推 QQ。**默认 false** |
| `asideTools` | `.bt` 旁问的权限档位：`"guarded"`（**默认**：改工作区文件、执行命令都弹审批 → 推到 QQ；沙盒目录里的改动不用审批）/ `"readonly"`（只读，不能写、不能跑）/ `"full"`（和普通回合一样）。每次调用时读 |
| `asideAgent` | `.bt` 旁问用哪个 agent。**默认 `"build"`**（opencode 自带的编码 agent，工具集完整）；`"inherit"` 沿用会话自己的 agent —— 注意 agent 的工具集是硬上限：如果它会话的 agent 没有 read/shell，旁问就只能凭已知信息回答 |
| `asidePrompt` | 追加到 `.btw` / `.bt` 提示词末尾的自定义要求（例如「回答用中文，先给结论」）。**默认空**，每次调用时读 |

> 这个文件含密钥，**永远不要提交**。它不在任何仓库里。

### 2. 装插件

```powershell
git clone git@github.com:FireChickenMP4/opencode-notify-qq.git
cd opencode-notify-qq
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

1. 把 `src/qqbot.ts`、`src/config.ts` 复制到 `~/.config/opencode/plugins/notify-qq/`
2. 把 `plugins/notify-qq.ts` 复制到 `~/.config/opencode/plugins/`
3. 检查凭据是否就位

### 3. 重启 opencode

插件在启动时加载。重启后 agent 就有 `notify_qq` 工具了。

> **改了 `src/` 下的支撑模块（含 `bridge.ts`）必须重启 opencode 服务才生效**：
> opencode 的热重载只重新执行插件文件本身，它 import 的模块会留在进程缓存里。
> 判断方法：
> `Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'notify_qq tool registered'`
> 看最后一条加载时间是否晚于你改文件的时间。

## 拿到自己的 openid

openid **按机器人隔离**（同一个人在不同机器人下不同），且没有查询接口，只能从事件里抓：

```bash
bun run src/listen.ts 90        # 监听 90 秒
```

然后用手机 QQ **给机器人发一条私聊消息**，终端会打印：

```text
[OPENID] user_openid = D6F7...
```

填进配置的 `notifyTarget.openid`。

## 用法

### 两种触发方式

| 方式 | 触发 | 默认 |
|---|---|---|
| **agent 主动推** | agent 判断该通知你时调 `notify_qq` | 开 |
| **离开时自动推** | 回合结束 **或** 有权限请求在等你 | **关** |

> **子代理结束默认不通知**：子代理结束时主会话仍在跑，报"完成"是误导。
> `OPENCODE_NOTIFY_SUBAGENT=1` 可开启，标题为 `opencode · 子代理完成 [标题]`。

### 我要离开电脑，需要时叫我

打开 `awayNotify.enabled`：

```json
{ "awayNotify": { "enabled": true } }
```

之后两种"需要你回来"的情况都会推 QQ：

- **回合结束**（任务跑完了，可以回来看）
- **权限请求**（agent **被卡住**了，必须你现在处理）

**改完立即生效**——配置在每次事件时重新读取，不需要重启 opencode，也不需要
agent 空闲（这正是你离开时的状态）。

### 快捷开关（shell 函数）

安装脚本会往 PowerShell profile 写入一个函数（**PS 5.1 与 pwsh 7 都写**，
因为你的交互 shell 通常是后者）：

```powershell
notify-qq on        # 我要离开了，任务完成推我
notify-qq off       # 回来了，别推
notify-qq status    # 看当前状态
notify-qq toggle    # 切换
```

**它只改配置文件，不经过 opencode** —— 所以 agent 正忙时也能用，改完立即生效。

> **为什么不做成 opencode 的 `/qq-on` 命令**：opencode 自定义命令本质是发一条
> prompt 走 agent，忙时会报 `Session is busy`——而这恰恰是你需要开开关的时刻。
> 而且为一个布尔值开一整轮 agent 本身就不合理。所以开关是配置文件，
> 命令形式被废弃。

agent 主动推仍随时可用（不依赖这个开关）：

> 我先去吃饭了，跑完通知我

### 命令行手动推

```bash
bun run src/notify.ts --check              # 校验凭据
bun run src/notify.ts "构建完成了"          # 推一条
bun run src/listen.ts 60                   # 监听事件（抓 openid 用）
```

## 远程审批（bridge）

`bridge` 订阅 opencode 服务的事件流，把待审批的请求推到 QQ，你回一个字就批准/拒绝。

### 启动

**什么都不用手动起。** opencode V2 自带常驻后台服务（服务自己注册 url 与密码），
插件会自动拉起 bridge；bridge 再用 `@opencode/client` 的 `Service.discover()`
找到那台服务并带上 Basic 鉴权——**不需要手动 `opencode serve`，也不需要 attach**。

**bridge 由插件自动确保在跑**，你不用手动起：

- 插件启动时探测锁端口（默认 `4097`）；没在跑就 detached 起一个
- 所以开 N 个 opencode 也**只有一个 bridge**
- bridge 是 detached 的，**opencode 关了它仍在**（这样你离开时审批照常）
- 插件关闭时**不**停 bridge（可能还有别的 opencode 在跑）

手动控制（可选）：

```powershell
bun run src/bridge.ts              # 手动起
bun run src/bridge.ts --check      # 验证配置 + 凭据 + 服务可达
```

关掉自动拉起：`OPENCODE_NOTIFY_QQ_BRIDGE=0`。

### 用

有权限请求时，QQ 收到：

```text
【需要授权】D:\Desktop\workflow
工具: bash
内容: rm -rf build
回复 .o=once  .a=always(记住)  .r=reject
```

回复（**大小写、单个字母或整词、中英文都认，前导 `.` 可省**）：

| 回复 | 效果 |
|---|---|
| `o` / `O` / `.o` / `once` / `Once` / `批准` | 只批这一次 |
| `a` / `A` / `.a` / `always` / `Always` / `记住` | 记住，之后同类不再问 |
| `r` / `R` / `.r` / `reject` / `Reject` / `拒绝` | 拒绝 |

多个请求挂起时按**先到先处理**（FIFO），避免 `o` 指向不明。

> **`reject` 之后**：opencode 自行决定后续（这不在我们控制内）。要继续就发 `.task`。

> **为什么 bridge 必须单例**：QQ 的 WSS 同一 appId+shard 多开会互踢
> （`op 9 Invalid Session`）。所以只能有一个进程持有连接，其余全走 HTTP。

### 远程指令

QQ 发以 `.` 开头的消息：

| 指令 | 效果 |
|---|---|
| `.task <内容>` | 派任务，**排队到本轮结束**（bridge 自己排队，回合结束才送出） |
| `.ask <内容>` | 立即插话进正在跑的回合；会话空闲时与 `.task` 等效 |
| `.btw <问题>` | **旁问**：用会话上下文一次性回答，不进对话、不打断回合。先回一条「已发出」再回答案；**用不了工具**（opencode 的 generate 就是这么定的），所以需要读文件/查网页的问题会答不出或答不全 —— 那类用 `.ask` / `.task` |
| `.bt <问题>` | **带工具的旁问**：把问题丢进这个会话的**临时分支**（fork）里跑一轮（并换用 `build` agent，工具集完整），答完就把分支删掉，主会话的记录与正在跑的回合都不受影响。默认档位 `guarded`：读文件、搜索随便用；**改工作区文件、执行命令都会弹审批推到 QQ**；沙盒目录里的实验不用审批。先回一条「已发出」再回答案 |
| `.list` | 列出这个 bridge 能寻址的会话：编号 + 目录 + 运行中/空闲 + 标题，按最近活动排序。默认最多 8 条（`OPENCODE_NOTIFY_QQ_LIST_LINES`）；只显示已经有编号的会话 |
| `.answer <内容>` | **回答** agent 的提问（`question` 工具）；没有待回答的问题时视为无效 |
| `.stop` | 中断当前执行，最高优先级 |
| `.status` | 查会话状态：运行中/空闲、最近十几行内容（`思考>`/`输出>`/`工具>`）、工具久跑标「可能卡住」 |

**目标会话**：默认用**最近一次收到事件的会话**；多会话时显式指定 `#<短编号>`，
例如 `.stop #2`、`.task #1 deploy it`、`.btw #3 这是啥`。

> **命令的结果一定回推**：`.task` / `.ask` 开始的那一轮，结束后会把**结果**（收尾文本）
> 推回 QQ，**不受 `awayNotify` 开关影响** —— 命令的结果是"回复"，不是单向推送。
> 只有插件一侧负责发送，所以开关开着时也不会既发自动推送、又发回复（不会重复）。
> 实现：bridge 注入后落一个标记，插件在回合结束时消费它并据此放行；标记带 TTL
> （默认 6 小时，`OPENCODE_NOTIFY_QQ_OUTCOME_TTL_MS` 可调）。
> （`.btw` / `.bt` 是即时问答，由 bridge 直接回复，不需要标记；`.bt` 的回复开头会带你问的
> 那个会话的编号 `#N`，因为 aside 本身是临时 fork、不留编号。）
>
> **`.bt` 不会额外打扰其它插件**：aside 是 fork、没有 `parentID`，所以 win / email / QQ
> 三个插件都另外认 bridge 打在它身上的 aside 标记（`metadata {aside:true}` 或标题前缀
> 「旁问 ·」），不会为它推「完成」。
>
> **两个旁问都带一段固定框架**：告诉模型这是「QQ 旁问」、答案直接推到手机、要结论不要派活，
> 再按命令补能力边界（`.btw` 无工具 / `.bt` 在只读分支里）；想加自己的要求就用配置里的
> `asidePrompt`（追加在最后）。
>
> 同理，「agent 提问」（`question` 工具）也是**需要你回应**的，所以同样**不受开关管**：
> bridge 会把题目与选项推给你，回 `.answer <内容>` 即可（可写选项文字，也可写自由文本；
> 没有待回答的问题时该命令无效，就像过期的审批回复）。开关（`awayNotify`）只控制
> **单向推送**：回合完成、子代理完成、bash 久跑、重试告警。

### 回合结束的总结

开着 `awayNotify` 时，完成通知不再是干巴巴的"完成"，而是带**本轮最后一段助手输出**：

```text
opencode · 完成 [D:\Desktop\workflow]
重构完成：拆出 config 层，QQ 通知改为每次读配置，20 个单测通过。
```

实现上**读现有 transcript**，不调 `POST /session/{id}/summarize` —— 后者要再跑一轮
模型，慢且花钱，而我们只想要个标题。`OPENCODE_NOTIFY_QQ_SUMMARY=0` 可退回纯"完成"。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOTIFY_QQ_CONFIG` | `~/.config/opencode/notify-qq.json` | 配置路径 |
| `OPENCODE_NOTIFY_QQ_DEDUP_MS` | `5000` | 同类通知去抖窗口（跨重复加载的实例生效） |
| `OPENCODE_NOTIFY_QQ_PERMISSION_GRACE_MS` | `1500` | 仅在 `cli.json` 设为 `autoaccept` 时生效：等此时长确认权限是否已被自动批准 |
| `OPENCODE_NOTIFY_QQ_BASH_MS` | `90000` | bash 久跑告警阈值，设 `0` 关闭 |
| `OPENCODE_NOTIFY_QQ_RETRY_MS` | `60000` | 持续重试多久才提醒一次 |
| `OPENCODE_NOTIFY_QQ_MAX_CHARS` | `4000` | 完成推送正文的截断长度 |
| `OPENCODE_NOTIFY_SUBAGENT` | `0` | 设 `1` 也通知子代理结束 |
| `OPENCODE_NOTIFY_QQ_LOCK_PORT` | `4097` | bridge 单例锁端口 |
| `OPENCODE_NOTIFY_QQ_BRIDGE` | `1` | 设 `0` 不自动拉起 bridge |
| `OPENCODE_NOTIFY_QQ_SUMMARY` | `1` | 设 `0` 完成通知不带总结 |
| `OPENCODE_NOTIFY_QQ_LOG` | `1` | 设 `0` 关闭事件日志 |

事件日志在 `~/.config/opencode/plugins/notify-qq.events.log`，记录
`permission.asked`、`session.retry.scheduled`、回合结束（`session.step.ended` 且
`finish` 不是 `tool-calls`）以及每次发送结果与去抖决定——"该通知却没通知"时先看它。

## 已知限制

- **主动消息窗口**：官方对主动推送有限制——用户近期未与机器人交互时可能被拒。所以"你刚说过话"的窗口内最可靠。
- **私聊**：`c2c` 需要用户先添加机器人。
- **勿扰**：这是 QQ 消息，不走本机勿扰；手机端由 QQ 自己的设置决定。

## 文件

```text
src/
  qqbot.ts        # 官方 Bot 客户端（纯手写，REST + WSS）
  config.ts       # 配置层（密钥 + awayNotify 开关，不进仓库）
  config.test.ts  # 配置层单测
  notify-qq.ps1   # 快捷开关 CLI（on/off/status/toggle）
  notify.ts       # 推送 / 校验 CLI
  listen.ts       # 有界监听（抓 openid、调试事件）
  bridge.ts       # 远程审批 daemon（事件流 + QQ，单例）
  bridge.test.ts  # 回复解析单测
  lock.test.ts    # 单例锁单测
plugins/
  notify-qq.ts    # opencode plugin：notify_qq 工具 + 回合完成钩子 + 命令
install.ps1       # 一键安装
PLAN.md           # 设计取舍与后续规划
```

## License

MIT
