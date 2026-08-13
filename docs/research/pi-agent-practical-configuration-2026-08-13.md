# Pi Coding Agent 实用配置方案

> 调研日期：2026-08-13  
> 对象：Earendil Works 的 Pi Coding Agent（不是 Inflection Pi）  
> 目标：为当前 macOS + Cognia 大型 monorepo 配置一套低噪声、可控、可逐步增强的日常开发环境。

## 结论

最合适的方案不是“装满 Pi 生态”，而是以下三层：

1. **稳定基线**：固定 Pi 版本，使用 3 个明确分工的模型，保留官方压缩/重试默认值，项目默认信任保持 `ask`。
2. **Cognia 专用入口**：用 `--no-skills` 关闭自动 skill 扫描，再按任务只加载少量仓库 skill；由仓库现有 `AGENTS.md` 承担长期项目规则。
3. **按需增强**：第二阶段才加入 MCP 和权限提示；子代理与长期记忆不进入默认配置。

这套取舍针对本机尤其重要：当前 Pi 尚未安装；Node `v26.5.0` 已满足 Pi `>=22.19.0` 的要求；Cognia 中有 47 个项目级和 64 个全局 `SKILL.md`，合计 111 个会被 Pi [自动发现](https://pi.dev/docs/latest/skills)。Pi 虽然只在启动时注入每个 skill 的名称与描述，但 111 个描述仍会带来明显的上下文噪声和选择干扰。

## 先采用的配置

### 1. 固定安装版本

当前最新版本为 [`0.84.1`](https://github.com/earendil-works/pi/releases/tag/v0.84.1)。Pi 仍是 `0.x` 且发布节奏快，应锁定精确版本：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
pi --version
```

`--ignore-scripts` 是[官方安装方式](https://pi.dev/docs/latest/quickstart)之一；Pi 正常安装不依赖 lifecycle scripts。首次启动后用 `/login` 登录。若已有 ChatGPT Plus/Pro，可先选 `openai-codex`；API key 不应写入 `settings.json` 或仓库文件。

### 2. 全局设置

建议写入 `~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-terra",
  "defaultThinkingLevel": "medium",
  "enabledModels": [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-sol"
  ],
  "defaultProjectTrust": "ask",
  "externalEditor": "code --wait",
  "enableInstallTelemetry": false,
  "showCacheMissNotices": true,
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  },
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "images": {
    "autoResize": true
  },
  "packages": []
}
```

说明：

- `Terra + medium` 作为日常默认，`Luna` 用于低成本侦察，`Sol + high` 用于高风险实现、架构和复杂调试。模型目录只证明它们当前可用；角色划分是基于成本与任务风险的配置建议，不是官方质量排名。
- `enabledModels` 只放 3 个精确模型，避免 `Ctrl+P` 在上千个模型中循环。
- 保留官方 compaction 默认值，先观察真实长会话再调整。不要因为模型窗口大就关闭压缩。
- provider 层重试维持 `0`。[官方 settings 文档](https://pi.dev/docs/latest/settings#retry)特别提醒，双层重试可能在额度错误时把进程长时间卡住。
- `defaultProjectTrust` 不要设为 `always`。项目 trust 允许加载/安装项目包并执行项目 extension，但它并不是工具沙箱。
- `showCacheMissNotices` 有助于判断 AGENTS、skills 或工具定义是否频繁破坏 prompt cache；若觉得干扰，可改回默认 `false`。

如果没有 ChatGPT Plus/Pro，把 provider/model 替换成已拥有凭据的组合。较稳妥的备选是 `anthropic/claude-sonnet-5`；不要为了“多模型”同时维护许多付费 provider。

### 3. Cognia 项目设置

若希望团队共享，创建 `.pi/settings.json`，只放无密钥、无个人路径的项目覆盖项：

```json
{
  "defaultTools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
  "compaction": {
    "keepRecentTokens": 24000
  },
  "branchSummary": {
    "skipPrompt": false
  },
  "packages": []
}
```

专用 `grep`、`find`、`ls` 工具让只读调查更清晰，也便于未来将只读工具和写操作分级。`24000` 是面向大型 monorepo 的温和调整；如果一周内未观察到上下文丢失，保留官方 `20000` 也完全合理。

当前仓库 `.gitignore` 没有 `.pi/` 规则。若提交项目设置，应采用**白名单思路**：只提交经过评审的 `.pi/settings.json`、`.pi/prompts/*.md` 和必要 extension 源码；会话、缓存、下载包、token、MCP 凭据必须留在 `~/.pi/agent/` 或加入忽略规则。

### 4. Cognia 专用启动入口

Pi 会自动扫描 `~/.agents/skills` 和项目 `.agents/skills`。本机合计 111 个 skill，不建议默认全部启用。日常从仓库根目录启动：

```bash
pi --no-skills \
  --skill .agents/skills/concurrent-tree-safety \
  --skill .agents/skills/next-best-practices \
  --skill .agents/skills/jest-gotchas \
  --skill .agents/skills/preflight
```

可把它做成 shell function `pi-cognia`，但不要把个人 shell 配置提交到仓库。基础 4 个 skill 分别覆盖并发工作树安全、Next.js 约束、测试陷阱和完成前检查。任务需要时再增加：

- AI SDK：`--skill .agents/skills/ai-sdk`
- Tauri 调试/冒烟：`--skill .agents/skills/tauri-agent-debug` 或 `tauri-smoke`
- E2E：`--skill .agents/skills/cognia-e2e`
- 工作流节点：`--skill .agents/skills/workflow-node`

不建议复制一份 `.pi/SYSTEM.md`。Pi 会自动读取全局和仓库 `AGENTS.md`/`CLAUDE.md`；当前根 `AGENTS.md` 已经很完整，复制会造成规则漂移，而 `.pi/SYSTEM.md` 还会替换 Pi 默认 system prompt。

## 推荐工作流

### 会话开始

1. 从仓库根目录运行 `pi-cognia`。
2. 第一次看到 trust 提示时，先检查 `.pi/settings.json`、`.pi/extensions/`、`.agents/skills/` 和项目 package 声明，再决定 `/trust`。
3. 用一句话声明目标、完成标准和不允许触碰的区域。
4. 先用 `Luna` 或 `Terra` 做只读调查；真正修改前确认计划与验证命令。

### 模型切换

| 场景                         | 模型  | Thinking |
| ---------------------------- | ----- | -------- |
| 文件定位、简单问答、日志归纳 | Luna  | `low`    |
| 普通实现、测试、重构         | Terra | `medium` |
| 架构、疑难调试、高风险审查   | Sol   | `high`   |

不要把 `max` 设为默认。它更慢、更贵，也不会自动弥补模糊任务或过量上下文。

### 长会话

- 一个会话只承担一个可验证目标；功能阶段改变时开新 branch/session，或先手动 `/compact`。
- 压缩前让 agent 写下：当前结论、未解决风险、改动文件、验证状态、下一步。
- 大段构建日志写入文件后只读取错误摘要，不要反复把完整日志塞进上下文。
- 使用 `/tree` 保留调查分支，不要把每次试错都留在主干上下文。

## 第二阶段：MCP

基线稳定一周后，只有出现明确工具需求时再加入 MCP。当前较成熟的社区选择是 [`pi-mcp-adapter@2.23.0`](https://pi.dev/packages/pi-mcp-adapter)，但它仍是拥有完整进程权限的第三方 extension，必须审查并锁版本。

建议配置原则：

```json
{
  "packages": [
    {
      "source": "npm:pi-mcp-adapter@2.23.0",
      "skills": []
    }
  ]
}
```

- 禁用包自带 skill，继续由 Cognia 启动入口控制 skill 集合。
- 首先只接 1 个 server；项目共享配置用 `.mcp.json`，Pi 专用覆盖才用 `.pi/mcp.json`。
- 使用默认单一 `mcp` 代理工具和 lazy lifecycle。它让 MCP 工具元数据不全部进入 system prompt，并在首次调用时才连接。
- 只有 5–20 个极常用工具才配置 `directTools`；大型 server 保持 proxy 模式。
- stdio server 的包名也锁版本，例如 `chrome-devtools-mcp@1.6.0`；避免不固定版本的 `npx -y some-server`。
- token 放环境变量或系统凭据存储，不写 `.mcp.json`。
- 写操作工具配置 `approveTools`；仍需记住这只是交互门，不是 OS 安全边界。

## 第二阶段：权限与隔离

Pi [官方安全文档](https://pi.dev/docs/latest/security)明确说明：它没有内建 permission system 或 sandbox；project trust 只决定是否加载项目资源。正确边界是：

1. 普通信任仓库的交互式使用：采用官方示例 `permission-gate.ts` / `protected-paths.ts` 的小型、可审查 extension，对删除、覆盖、外部路径和高风险网络命令提示确认。
2. 陌生仓库、自动运行、处理不可信输入：把**整个 Pi 进程**放进 container/VM/OpenShell/Gondolin，并只挂载目标目录、最小凭据与必要网络。
3. 不把 `pi-permission-system` 等社区扩展称为“沙箱”。它们可改善确认体验，但仍与 Pi 同进程、同权限运行。

## 暂不进入默认配置

- **子代理**：Pi 原生没有 subagent。社区包普遍较新，而且 Cognia/Codex 已有并行代理能力。先用单代理把模型、skills、工具与验证习惯调稳，再按明确的 scout/reviewer 场景评估一个锁版本实现。
- **长期记忆**：先用 `AGENTS.md`、项目 prompt 和 Pi session。当前 memory 包成熟度不高，且会新增隐私、过期事实和错误检索问题。
- **大而全的 system prompt**：会与仓库规则重复并损害 cache 稳定性。
- **自动信任所有项目**、**自动更新所有 packages**、**宽泛 `directTools: true`**：三者都会显著扩大供应链、权限或上下文面。

## 分阶段落地清单

### 第 0 天

- 固定安装 `@earendil-works/pi-coding-agent@0.84.1`。
- `/login` 登录一个主 provider。
- 写全局 settings；项目 packages 保持空数组。
- 用 `pi-cognia` 只加载 4 个基础 skill。
- 做三项 smoke test：只读仓库调查、一个小测试修复、一次长上下文 compaction。

### 第 1 周

- 记录模型切换次数、失败重试、cache miss、压缩后遗漏、无关 skill 触发。
- 只有真实需求才调整 `keepRecentTokens` 或增减 skill。
- 审查并加入 permission gate。

### 第 2 周以后

- 需要浏览器/文档/代码托管工具时，加入锁版本的 MCP adapter 和一个 server。
- 每次只新增一个 package，跑同一套 smoke test，确认上下文体积和启动时间。
- 每月固定窗口查看 Pi changelog 后升级；不要无审查 `pi update --all`。

## 验收标准

一套“好用”的配置应满足：

- 启动时模型列表不超过 3–4 个、默认 skills 不超过 4–8 个；
- 普通任务用 `Terra + medium` 无需频繁手调；
- 只读调查不需要 `bash` 拼接复杂搜索命令；
- 长会话压缩后仍保留目标、改动、验证和风险；
- 项目 trust、写操作批准、OS 隔离三个概念不混淆；
- 所有 Pi 和社区包都有精确版本；
- 仓库内不出现 auth、session、cache、MCP token；
- 新增 extension/package 后能明确说明它解决了哪个实际问题。

## 主要来源

- [Pi Quickstart](https://pi.dev/docs/latest/quickstart)
- [Pi Settings](https://pi.dev/docs/latest/settings)
- [Pi Providers](https://pi.dev/docs/latest/providers)
- [Pi Model Catalog](https://pi.dev/models)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi Prompt Templates](https://pi.dev/docs/latest/prompt-templates)
- [Pi Compaction](https://pi.dev/docs/latest/compaction)
- [Pi Packages](https://pi.dev/docs/latest/packages)
- [Pi Security](https://pi.dev/docs/latest/security)
- [Pi Containerization](https://pi.dev/docs/latest/containerization)
- [Pi `v0.84.1` release](https://github.com/earendil-works/pi/releases/tag/v0.84.1)
- [`pi-mcp-adapter` package](https://pi.dev/packages/pi-mcp-adapter)
- [`pi-mcp-adapter` repository](https://github.com/nicobailon/pi-mcp-adapter)

## 与既有 Pi 调研的关系

本报告只回答“如何配置一套好用的 Pi”。Pi 的架构、Cognia 当前 `pi-acp` 集成边界、原生 RPC 适配建议与横向比较，见同目录的 [pi-agent-research-2026-08-13.md](./pi-agent-research-2026-08-13.md)。
