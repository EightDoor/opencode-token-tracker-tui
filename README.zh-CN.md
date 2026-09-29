# opencode-token-tracker-tui

面向 [OpenCode 2](https://opencode.ai) 的 token 用量与成本追踪：服务端插件 + TUI sidebar 实时摘要。

[English](./README.md) | [简体中文](./README.zh-CN.md)

> 维护者：[EightDoor](https://github.com/EightDoor)
> 仓库：[EightDoor/opencode-token-tracker-tui](https://github.com/EightDoor/opencode-token-tracker-tui)
> npm 包：[`opencode-token-tracker-tui`](https://www.npmjs.com/package/opencode-token-tracker-tui)
> 许可证：MIT（见 [`LICENSE`](./LICENSE)）
>
> 项目所有者：EightDoor。GitHub 仓库、npm 包、`LICENSE` 中的版权署名都归属同一所有人。

## 你能得到什么

- **OpenCode 2 服务端插件**：监听 `session.step.ended`、`session.step.failed`、`session.status` 事件，将每个可计费的 step 写入本地 JSONL 日志（含 model、provider、tokens、cost、timestamp）。
- **TUI sidebar 摘要**：`./tui` 子路径导出一个轻量 block，追加到 OpenCode 2 的 sidebar（`sidebar.content` slot）。内容包含 today/week/month 三行（tokens、cost、messages）、今日 cache 命中率、今日 cost 最高的 5 个模型。**不**会触碰右侧 content 面板 —— 你的会话视图保持不变。

> 想要过去 CLI 提供的统计视图？本版本已移除。所有可见的洞察都集中在 TUI sidebar；如需深入分析，可直接读取本地 JSONL 日志（见 [数据保存位置](#数据保存位置)）。

## 安装

npm 包名为 `opencode-token-tracker-tui`。OpenCode 2 会从一个 npm 安装中自动发现 `./tui` 子路径。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-token-tracker-tui"]
}
```

重启 OpenCode，服务端追踪与 sidebar 摘要会同时激活。

## 数据保存位置

| 类型 | 路径 |
| --- | --- |
| 配置 | `~/.config/opencode/token-tracker.json` |
| Token 日志 | `~/.config/opencode/logs/token-tracker/tokens.jsonl` |

可通过环境变量覆盖：`TOKEN_TRACKER_CONFIG_FILE`、`TOKEN_TRACKER_LOG_FILE`。

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

## TUI sidebar

TUI 插件只贡献一个 slot：`append: "sidebar.content"`。sidebar 内呈现的内容类似：

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

- 按 `panel.refreshSeconds`（默认 5s）周期刷新，并在每次 `session.step.ended` / `session.step.failed` 事件时立即刷新。
- 配置中 `panel.enabled: false` 可关闭 sidebar，不影响服务端追踪。
- 插件**不会**调用 `ui.panel.open` —— 那会替换右侧 content 面板，覆盖你的会话视图。追加到 sidebar 才能保留其他内容。

## 配置参考

```json
{
  "providers": {
    "github-copilot": { "input": 0, "output": 0 }
  },
  "models": {
    "my-custom-model": { "input": 1, "output": 2 },
    "deepseek/deepseek-v4-flash": {
      "openrouter":  { "input": 0.14, "output": 0.28, "cacheRead": 0.0028 },
      "siliconflow": { "input": 0.2,  "output": 0.4 }
    }
  },
  "panel": {
    "enabled": true,
    "refreshSeconds": 5
  }
}
```

### 定价字段（USD / 1M tokens）

| 字段 | 含义 |
| --- | --- |
| `input` | 输入 / 提示 token |
| `output` | 输出 / 补全 token |
| `cacheRead` | 缓存命中 token（可选） |
| `cacheWrite` | 缓存写入 token（可选） |

### 定价解析顺序（命中即止）

1. `providers[<provider>]` 覆盖
2. `models[<model>]` 精确匹配（用户配置）
3. 内置定价表精确匹配
4. 内置定价表部分匹配（key 最长优先）
5. 用户 `models` 部分匹配（key 最长优先）
6. 默认回退：`$1` input / `$4` output（每 1M）

精确用户配置优先于内置；宽泛用户部分匹配排在内置匹配之后，避免 `"claude"` 这类泛 key 意外覆盖精确的内置价格。

### 常见场景

| 场景 | 覆盖方式 |
| --- | --- |
| 订阅制（Copilot、Cursor） | Provider 覆盖：`{ "input": 0, "output": 0 }` |
| 本地免费（Ollama、LM Studio） | Provider 覆盖：`{ "input": 0, "output": 0 }` |
| 付费 provider 下的本地模型 | Model 覆盖：`{ "input": 0, "output": 0 }` |

## 内置定价支持的模型

| Provider | Models |
| --- | --- |
| Anthropic | Claude Opus 4.x、Sonnet 4 / 4.5、Haiku 4 / 4.5 |
| OpenAI | GPT-5.x、GPT-4.1、GPT-4o、o1 / o3 / o4 |
| DeepSeek | deepseek-chat、deepseek-reasoner、deepseek-v4-pro |
| Google | Gemini 2.5 / 3 / 3.1 / 3.5 |

未知模型使用默认定价估算。

## 准确性与限制

- **成本均为估算值**，由本地 token 日志及内置（或用户配置）的定价表计算得出。这可能与 Provider 官方账单存在差异 —— 例如使用促销额度、企业折扣或特定定价优惠时。
- **订阅制 / 打包 / 本地 provider**（Copilot、Cursor、Ollama、LM Studio）应在配置中覆写为 0。
- **定价数据时效性**：内置表为手动维护。在配置中追加覆盖即可处理价格变动。

## 开发

```bash
git clone https://github.com/EightDoor/opencode-token-tracker-tui.git
cd opencode-token-tracker-tui
npm install
npm run build
npm test

# 真实本机 OpenCode CLI dogfood
node scripts/real-opencode-cli-smoke.mjs --use-temporary-link --model deepseek/deepseek-chat
```

dogfood 脚本仅在仓库内使用（不发布为 npm 命令），验证真实 `opencode run` 路径，运行结束后恢复临时 package link。

## License

MIT © [EightDoor](https://github.com/EightDoor)。

完整文本见 `LICENSE`。

## Related

- [OpenCode](https://opencode.ai) — AI 编程助手
- [OpenCode 插件文档](https://opencode.ai/docs/plugins) — 插件加载机制
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — 另一个流行的 OpenCode 增强插件