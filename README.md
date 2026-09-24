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
  }
}
```

| 字段 | 说明 |
|---|---|
| `appId` / `clientSecret` | 开放平台管理端获得 |
| `sandbox` | 沙箱环境填 `true`（域名与凭据都不同） |
| `notifyTarget.type` | `c2c`（单聊）或 `group`（群聊） |
| `notifyTarget.openid` | `c2c` 用；`group` 时改用 `groupOpenid` |
| `awayNotify.enabled` | 回合结束时**自动**推 QQ。**默认 false** |

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
plugins/
  notify-qq.ts    # opencode plugin：notify_qq 工具 + idle 钩子 + 命令
install.ps1       # 一键安装
PLAN.md           # 设计取舍与后续规划
```

## License

MIT
