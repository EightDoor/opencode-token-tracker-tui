# Walkthrough

本目录是一条端到端的使用路径，帮助用户确认 OpenCode 2 插件已经安装、正在记录真实请求的 token 用量，并能通过 TUI sidebar 直观看到数据。

## 1. 安装并启用

### 1.1 OpenCode 2 插件

在 OpenCode 2 配置中启用：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-token-tracker-tui"]
}
```

重启 OpenCode，服务端 token 追踪与 TUI sidebar 会同时激活。无需额外 CLI 或全局安装步骤。

## 2. 确认插件正在记录

### 2.1 触发一次真实请求

在 TUI 中执行一次正常的提示（例如 `npx`），OpenCode 会向配置的 provider 发请求并产生计费记录。

### 2.2 检查 JSONL 日志

每条 JSONL 记录对应一次可计费 step：

```json
{
  "type": "tokens",
  "sessionId": "ses_xxx",
  "messageId": "msg_xxx",
  "agent": "build",
  "model": "claude-opus-4.5",
  "provider": "github-copilot",
  "input": 1500,
  "output": 350,
  "reasoning": 0,
  "cacheRead": 5000,
  "cacheWrite": 0,
  "cost": 0.0234,
  "_ts": 1716000000000
}
```

文件位置：

| 类型 | 路径 |
| --- | --- |
| 配置 | `~/.config/opencode/token-tracker.json` |
| Token 日志 | `~/.config/opencode/logs/token-tracker/tokens.jsonl` |

### 2.3 查看 TUI sidebar

重启 OpenCode 后，侧边栏会显示一个紧凑的实时摘要：

```
Token Tracker · 3s ago
────────────────────────────────────
today       1.20M tok   $4.2130    42 msgs
week        6.40M tok  $21.4520   188 msgs
month      22.10M tok  $74.3300   612 msgs

cache hit 78%
top models (today)
  1. claude-opus-4.5 $3.12 (74%)
  2. deepseek-chat   $0.55 (13%)
  3. gpt-5.2         $0.41 (10%)
  …+2 more
```

如果 sidebar 没有出现，请按以下顺序排查：

1. 确认 `~/.config/opencode/config.json` 中 `plugins` 数组已包含 `opencode-token-tracker-tui`；
2. 重启 OpenCode；
3. 在 `~/.config/opencode/token-tracker.json` 中确认 `panel.enabled` 不是 `false`；
4. 检查 `~/.config/opencode/logs/token-tracker/tokens.jsonl` 是否存在并包含新记录。

## 3. 进阶配置

### 3.1 调整 sidebar 刷新频率

```json
{
  "panel": {
    "enabled": true,
    "refreshSeconds": 5
  }
}
```

将 `refreshSeconds` 调大可减少 sidebar 轮询成本；调小可让数据更实时。

### 3.2 关闭 sidebar 但继续记录

```json
{
  "panel": {
    "enabled": false
  }
}
```

服务端 token 记录会继续运行，只是不再向 sidebar 追加摘要。

### 3.3 处理零成本 provider

在配置中显式覆盖订阅制 / 免费的 provider：
```json
{
  "providers": {
    "github-copilot": { "input": 0, "output": 0 },
    "ollama":         { "input": 0, "output": 0 }
  }
}
```

## 4. 开发自检

仓库内提供真实 OpenCode CLI dogfood 脚本，用于插件作者验证当前工作区代码：

```bash
node scripts/real-opencode-cli-smoke.mjs --use-temporary-link --model deepseek/deepseek-chat
```

验收口径：

- OpenCode CLI 真实请求退出码为 0
- JSONL 日志新增至少 1 条 `type === "tokens"` 记录
- 新增记录的 `model`、`provider` 与本次请求一致

## 5. 数据导出（可选）

如果需要把日志导入到外部脚本分析，可直接读取 JSONL：

```bash
# 最近 24 小时成本合计
awk -F'"cost":' '/"type":"tokens"/ {print $2}' ~/.config/opencode/logs/token-tracker/tokens.jsonl | awk -F',' '{sum+=$1} END {printf "%.4f\n", sum}'
```