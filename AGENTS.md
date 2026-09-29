# AGENTS.md

OpenCode Token Tracker TUI 仓库的 AI 协作入口。

## 1) 项目概览

- 项目：OpenCode Token Tracker TUI（OpenCode 2 插件 + TUI sidebar）
- 目标：实时追踪 token 用量与成本，在 TUI sidebar 中展示紧凑摘要
- 主文件：`index.ts`（插件入口）、`tui/index.ts`（TUI sidebar）、`lib/shared.ts`（共享模块）
- 技术栈：TypeScript strict + ESM（Node >= 20）
- 发布：npm 包 `opencode-token-tracker-tui`
- 仓库地址：https://github.com/EightDoor/opencode-token-tracker-tui

## 2) 语言与输出规则

- 默认使用中文沟通
- 技术术语、命令、标识符保留英文
- 文档新增优先中文，除非仓库已有明确英文规范

## 3) 项目结构

| 路径 | 用途 |
| --- | --- |
| `index.ts` | OpenCode 2 插件入口，监听 `session.step.ended` 等事件并写入 JSONL |
| `tui/index.ts` | TUI sidebar 摘要组件 |
| `lib/shared.ts` | 共享模块：定价表、配置类型、工具函数 |
| `scripts/real-opencode-cli-smoke.mjs` | 真实 OpenCode CLI dogfood 脚本 |
| `test/` | `node:test` 测试用例 |
| `.github/workflows/ci.yml` | 构建与测试 CI |
| `walkthrough.md` | 端到端使用与验证路径 |
| `token-tracker.example.json` | 用户配置示例 |

## 4) 开发硬约束

- 分支策略遵循 `CONTRIBUTING.md`：`feature/*` 或 `fix/*` -> PR 到 `dev` -> PR 到 `main`
- 提交信息遵循 Conventional Commits（`feat|fix|docs|chore|refactor|test`）
- 测试框架：Node.js 内置 `node:test`，验证方式为 `npm test`（含构建 + 测试）
- `dist/` 为构建产物目录，不手动编辑
- 除 `@opencode/plugin` 外不引入额外运行时依赖
- 本仓库不再维护 `opencode-tokens` CLI

## 5) 架构与实现要点

### 数据流

1. 监听 OpenCode 2 事件：`session.step.ended`、`session.step.failed`、`session.status`
2. 使用 `messageId-input-output` 去重 token 记录
3. 定价查找顺序：provider 覆盖 -> 用户 model 精确匹配 -> 内置精确匹配 -> 内置部分匹配 -> 用户 model 部分匹配 -> 默认值
4. 持久化到 `~/.config/opencode/logs/token-tracker/tokens.jsonl`（JSONL）
5. 会话统计保存在内存 `Map<string, SessionStats>`
6. TUI sidebar 通过 `./tui` 子路径订阅并展示摘要

### 关键注意事项

- `BUILTIN_PRICING` 已统一到 `lib/shared.ts`，修改定价只需改一处
- `seen` 去重集合存在上限以控制内存
- TUI sidebar 不会调用 `ui.panel.open`，避免覆盖右侧 content 面板

## 6) 自动行为约定（Agent Runtime）

- 修改代码前优先阅读 `index.ts`、`tui/index.ts`、`lib/shared.ts` 与 `walkthrough.md`
- 涉及代码风格判断时，参考仓库内现有 TypeScript 代码风格（strict + ESM）
- 若发现文档与代码现状冲突，以代码现状为准，并回写更新文档

## 7) 常用命令

```bash
# 安装依赖
npm install

# 构建与类型检查
npm run build

# 运行测试（含构建）
npm test

# 真实本机 OpenCode CLI dogfood
npm run build && node scripts/real-opencode-cli-smoke.mjs --use-temporary-link --model deepseek/deepseek-chat
```