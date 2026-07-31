# Cognia 子系统上线成熟度评估

> 状态：待确认（请在 §3 勾选表上拍板）
> 日期：2026-08-01
> 用途：决定 [官网 `/product`](../../web/) 可以写什么。未被勾选的子系统不写进 `web/content/{en,zh}.ts`。
> 治理依据：[V2 设计方案 §9 内容与事实治理](./cognia-official-website-v2-design-spec-2026-07-26.md)（每条承诺必须绑定真实来源；禁止 `production-ready` / `enterprise-grade` / `fully private` / `everything stays local` / `unlimited` / 假 KPI）与 [ADR-0092 §7](../content/docs/en/adr/0092-official-website-workspace.md)（降级到真相，绝不降级到死链）。

## 0. 方法与一条重要发现

判据不是「有没有 ADR」，也不是「有没有路由」——这两条**所有 12 个候选子系统都满足**，区分度为零。实际采用的判据是：

1. ADR 状态；
2. **当前代码**是否兑现 ADR 的承诺（ADR 会过时，本次查出两处）；
3. 平台覆盖差异（自报 `Capabilities`）；
4. 是否依赖用户自备凭据 / 系统权限 / 外部服务；
5. 该子系统是否落在仓库的**不可达组件基线**里（`scripts/gates/unreachable-component-baseline.json`，23 项）；
6. 是否与方案 §1.1「官网不再把 Cognia 描述为泛化的 AI for everything」和 §1.4 首要用户冲突。

**两处 ADR 陈述已过时，以代码为准：**

| ADR 原文                                                                                   | 当前代码                                                                                                                                                                                                                                                                                         | 结论                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| ADR-0003：「`lib/claude/build-options.ts` 尚未调用 `applyTwinContext`，runtime 是 opt-in」 | `lib/claude/build-options.ts:379-395` 已有 `twinDeps` / `twinUserMessage` 入参，`resolveSendOptions` 会调用 `applyTwinContext`                                                                                                                                                                   | **已接线，ADR 过时**            |
| ADR-0020：「macOS / Linux 的 UIA 等价树遍历仍延后（Phase 6.b）」                           | macOS `ax` 后端 4 文件 / **2466 行**，完整实现 `read_tree` / `read_application_tree` / `subscribe_events` / `invoke_pattern` / `hold_key` / `pick_at_point`（比 Windows `uia` 的 1789 行还多）；Linux `atspi` 仅 605 行，自报 `has_a11y_tree: false`、`read_tree` 直接返回 `UnsupportedPlatform` | **macOS 已完成，仅 Linux 仍缺** |

**一条阻断性发现（见 §2.9）：`share.cognia.cn` 解析为 NXDOMAIN，公开分享服务未上线。** 同时 `cognia.cn` 本身返回 HTTP 525（Cloudflare 回源 TLS 握手失败）。对照组 `github.com` 返回 200，排除本机网络问题。

---

## 1. 评级口径

| 评级           | 含义                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| **可宣传**     | 功能完整、已接线、跨平台无重大差异；官网可正面陈述                             |
| **需限制措辞** | 功能真实存在但有平台差异 / 前置条件 / 已知边界；必须在文案里说清，不得笼统承诺 |
| **不要写**     | 服务未上线、或写上去会破坏定位；本轮不进 `/product`                            |

---

## 2. 逐项评估

### 2.1 Computer Use 桌面自动化（ADR-0020，Accepted）— **需限制措辞**

- macOS（`ax`）：完整。树遍历、事件订阅、控件模式调用、组合键、按点取元素、读取文本选区。
- Windows（`uia`）：完整（7 文件 / 1789 行）。
- **Linux（`atspi`）：仅输入模拟。** 自报 `has_uia: false`、`has_events: false`、`has_a11y_tree: false`，注释写明「minimum-viable enigo backend: input only, no AT-SPI tree」。**纯 Wayland 环境下连输入模拟与截图都会关闭**（`is_pure_wayland_without_xtools()`）。
- 需系统级无障碍 / 录屏权限。

**措辞约束**：不得写「跨平台桌面自动化」而不加限定。建议明确「macOS 与 Windows 提供完整的界面树与控件操作；Linux 目前为输入模拟」。

### 2.2 平台连接器 / 收件箱（ADR-0009 Accepted · 0025 · 0036 · 0089）— **可宣传（带条件）**

- 11 个真实适配器：`dingtalk` `discord` `lark` `matrix` `onebot` `qq-official` `slack` `telegram` `wechat-oa` `wechat-personal` `wecom`。
- 路由齐全：`/inbox` 及 `/inbox/{all,c,drafts,platform,adapter}` 六个，外加 `/me/connectors` 设置页。
- **注意**：23 个不可达组件里有 **5 个落在这一区**（`connectors/identity-merge-dialog`、`inbox/history-load-earlier`、`inbox/outbound-status-pill`、`settings/connections/forms/adapter-form`、`settings/connections/tabs/tunnel-tab`）。主链路可用，但部分辅助 UI 未挂载。
- 每个连接都需要用户自备 bot 凭据。

**措辞约束**：点名平台可以，但要写清凭据由用户自备；不要宣传「身份合并」「隧道」这类未挂载的能力。

### 2.3 内嵌浏览器（ADR-0055 / 0072 / 0073，均 Accepted）— **需限制措辞**

ADR-0055 自己写了「Honest Phase-1 limits（注入 JS 的天花板）」：

1. 跨源 iframe 对快照 / 控制台 / 网络 / 操作**完全不可见**；
2. 合成事件 `isTrusted:false` → 剪贴板、文件选择器、部分反爬流程会拒绝；
3. 拿不到网络响应**体**（只有状态与耗时）；
4. 闭合 shadow DOM 不可达。

ADR 自评：这些限制「对主要的 localhost 用例足够强」，公开站点的自动化引导到 Playwright MCP。

**措辞约束**：定位为「本地开发预览的自审与驱动」，不要写成通用网页自动化。

### 2.4 定时调度器（ADR-0002 / 0079 Accepted）— **可宣传**

`/scheduler` 路由 + `/me/scheduler` 设置页 + `scheduled-tasks-section.tsx`。独立 `SchedulerDatabase`。47 个源文件，其中 9 个依赖 Tauri（桌面侧真实定时执行）。无不可达组件。

### 2.5 统一模板平台（ADR-0100，Accepted）— **可宣传**

`/templates` 路由；**已在启动时挂载**（`components/providers/initializers/deferred-boot-initializers-impl.tsx:41` 渲染 `<TemplatePlatformInitializer />`）；Dexie v132。无不可达组件。

### 2.6 语音 / TTS（ADR-0075，Accepted 2026-07-17）— **可宣传（带条件）**

4 个引擎：`system`、`edge`（均无需密钥）、`openai`、`elevenlabs`（需用户自备密钥）。`/me/speech` 设置页 + `speech-section.tsx`。

**措辞约束**：不要笼统写「内置语音」；区分「无需配置即可用（system / edge）」与「需自备 provider 密钥（OpenAI / ElevenLabs）」。

### 2.7 Digital Twin 数字分身（ADR-0003）— **需限制措辞**

- 运行时**已接线**（见 §0）。`/twin` 路由存在，52 个源文件。
- ADR 明列尚未包含：非文档来源导入器（Slack / Lark / 钉钉 / 微信 / .mbox / .eml / git 仓库）——**Phase 7 只接受粘贴文本**；cron 驱动的蒸馏重试仍是手动 job-worker。
- 涉及大量个人数据，走 PII 红线（`packages/redact`）。

**措辞约束**：**绝不可写 `fully private` 或 `everything stays local`（方案 §9 明令禁止）**；不要暗示能直接接入聊天工具历史；如要写，只写文档 / 粘贴文本这条真实路径。

### 2.8 桌面宠物（ADR-0058，Accepted 2026-07-01）— **不要写（定位问题，非完成度问题）**

176 个源文件，`/pet`、`/pet-overlay`、`/pet-popup` 三个路由，独立设置区。**功能是完整的**——这里的建议与成熟度无关。

方案 §1.1 明写「官网不再把 Cognia 描述为……泛化的 AI for everything」，§1.4 把首要用户定为开发者与 AI power user。把桌面宠物放进 `/product` 会直接稀释「开放的 AI Agent 工作空间」这一定位。

**建议**：本轮不进 `/product`。若将来要讲，放 Use cases，且单独成篇。

### 2.9 公开分享链接（ADR-0037）— **不要写（服务未上线）**

- 默认端点 `lib/share/config.ts:9` → `https://share.cognia.cn`。
- **实测：`nslookup` 返回 NXDOMAIN——该域名不存在。** 对照组 `github.com` HTTP 200，排除网络问题。
- 附带发现：`cognia.cn` 返回 **HTTP 525**（Cloudflare 回源 TLS 握手失败），主域当前也未正常服务。

写上去等于制造死链，直接违反 ADR-0092 §7。**服务上线并可验证之前不写。**

### 2.10 会话导入（ADR-0062，Accepted 2026-07-04）— **可宣传**

支持 5 个外部 Agent 的会话历史导入：`aider`、`claude-code`、`codex`、`gemini`、`opencode`。对开发者受众极具体、极对味。无不可达组件。

### 2.11 Agent Team（ADR-0022 / 0032）— **可宣传（已部分覆盖）**

`/agent-teams` + `/agent-teams/workspace` + 两个设置页。官网 `/product` 的 Agents 章节已有 `agents` / `execution` / `external` 三条，属于加深而非新增。

### 2.12 OCR（ADR-0024）— **可宣传（已部分覆盖）**

`/me/ocr` 设置页，providers + `auto-router` + `credentials` + `pdf-router`。官网现已提及 4 次。部分 provider 需自备密钥（`credentials.ts`）。

---

## 3. 勾选表

请在「采纳」列打勾。未勾选的不写进官网。

| #   | 子系统                  | 评级             | 建议 `/product` 章节归属             | 采纳 |
| --- | ----------------------- | ---------------- | ------------------------------------ | :--: |
| 1   | Computer Use 桌面自动化 | 需限制措辞       | 新增 **Automation**                  |  ☐   |
| 2   | 平台连接器 / 收件箱     | 可宣传（带条件） | 新增 **Connections**                 |  ☐   |
| 3   | 内嵌浏览器              | 需限制措辞       | 归入 **Automation** 或 Desktop       |  ☐   |
| 4   | 定时调度器              | 可宣传           | 归入 **Automation**                  |  ☐   |
| 5   | 统一模板平台            | 可宣传           | 归入 **Agents** 或新增 **Templates** |  ☐   |
| 6   | 语音 / TTS              | 可宣传（带条件） | 归入 **Desktop**                     |  ☐   |
| 7   | Digital Twin 数字分身   | 需限制措辞       | 归入 **Knowledge**                   |  ☐   |
| 8   | 桌面宠物                | **不要写**       | —（建议不进本轮）                    |  ☐   |
| 9   | 公开分享链接            | **不要写**       | —（服务未上线）                      |  ☐   |
| 10  | 会话导入                | 可宣传           | 归入 **Agents**                      |  ☐   |
| 11  | Agent Team（加深）      | 可宣传           | 现有 **Agents**                      |  ☐   |
| 12  | OCR（加深）             | 可宣传           | 归入 **Knowledge**                   |  ☐   |

**按推荐勾选的结果**：`/product` 从现有 4 章（Chat / Agents / Knowledge / Desktop）扩到 **6 章**——新增 **Automation**（Computer Use + 内嵌浏览器 + 调度器）与 **Connections**（11 个平台适配器），并加深 Agents（模板平台 + 会话导入）、Knowledge（Twin + OCR）、Desktop（语音）。第 8、9 项不写。

## 4. 需要另行处理的事（不属于本次官网工作）

1. **`share.cognia.cn` 未部署、`cognia.cn` 回源 525**——影响的不只是分享功能，也影响官网本身的上线域名。
2. **ADR-0003 与 ADR-0020 的陈述已与代码不符**，建议各加一条 amendment，否则下一个读 ADR 的人会继续得到错误结论。
3. **connectors / inbox 区有 5 个不可达组件**，属于「建好但没接线」，是本仓库最常复发的缺陷类别。
