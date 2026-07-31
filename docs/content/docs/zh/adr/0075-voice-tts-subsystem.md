---
title: ADR-0075 — 语音 / TTS 子系统
description: "接管此前无文档的语音/TTS 子系统：从助手 token 流式朗读、退役靠冒充浏览器工作的 Edge 与被误用为纯 TTS 的语音对语音 Realtime 路径、为未来实时语音对话预留原生音频选项、结构化 provider 错误、让桌宠开口，并记录休眠判决。"
---

# ADR-0075 — 语音 / TTS 子系统

**状态**: 已接受 (2026-07-17)

## 背景

语音/TTS 子系统（`packages/tts/`、`crates/cognia-tts/`、`lib/tts/`、
`components/settings/speech/`、`app/me/speech/` 及桌宠）本是真材实料 —— 11 个
provider、适配器注册表、按 request-id 的取消模型、IndexedDB 音频缓存 —— 但
**从未有 ADR 记录其设计**。一次审计暴露出活 bug：朗读文本被 mangle（标题读成
「number」、代码块被朗读）、首音延迟等于「全文生成完 + 全文合成完」、缓存 key 碰撞、
Realtime 取消在 WebSocket 握手窗口内丢失、provider 错误塌缩成一条不透明字符串。
Edge provider 只能靠冒充 Edge 浏览器工作，Realtime provider 把语音对语音模型当纯
TTS 引擎用、成本约 5×。桌宠有完整 Live2D/SVG rig 却从不说话。

## 决策

- **流式朗读（D3）**：orchestrator 新增 `speakStream`，由增量拆句器驱动（首片段用
  宽分隔符抢延迟、之后用句末符保韵律）。自动朗读从 chat store 对助手正在生长的文本
  做差分、边到边喂，使首音在回复写完前就开始。片段始终按序播放；`speak(string)`
  对已持完整文本的调用方保持不变。

- **退役 Edge（O2）**：从 provider 选择器移除。它只能靠伪造（从 Edge 浏览器扒出的
  常量拼出 token + 伪造 UA 与 Origin）工作，无可接受的服务条款，且中国大陆 403。
  已持久化的选择仍可解析并显示退役提示；代码保留一版后删除。

- **退役 Realtime 作为 TTS（D2）、预留其传输（O1）**：把语音对语音 Realtime 模型
  纯当 TTS 用，音频输出约 $64/1M 对比 `gpt-4o-mini-tts` 的约 $12（`openai`
  provider 已经用后者走 REST 且支持 `instructions`），还要靠「逐字朗读」prompt 压制
  模型能动性。从选择器退役；语音对语音 WebSocket 传输
  （`crates/cognia-tts/src/realtime.rs`、`providers/openai-realtime.ts`）**保留，
  预留给未来的实时语音对话功能**。此预留正是音频归属留白的原因：macOS 回声消除要求
  同一进程同时拥有输入与输出流，故播放不能被永久固化在 WebView。原生 Rust 音频路径
  目前为空，故这仍是免费选择；Realtime 取消竞态仍已修复（改用存状态的 `watch` 信号），
  使预留链路对未来使用是正确的。

- **桌宠出声**：桌宠通过共享 orchestrator、以绑定角色的音色（复用
  `resolveCharacterVoice`）朗读其 LLM 回复，TTS 关闭时为 no-op。口型跟随声音（RMS
  包络 → 现有 7 形状 rig）**暂缓**：真实音量需把共享 `<audio>` 输出接入 Web Audio，
  且默认系统声无音频节点。桌宠说话时合成口型 flap 仍在运行。

- **正确性修复**：文本规范化在折叠空白与替换符号之前先剥离结构；语言从回复文本检测
  （而非麦克风设置）且假名优先于汉字；缓存 key 改 SHA-256 加版本前缀；桌面代理被约束
  到 provider 主机的 https 白名单，带超时、响应体上限、且错误绝不回显 URL 或 key；
  Rust keyring 清单钉死到 TS 源；CJK 发音词典按子串匹配。provider 失败现携带错误类别、
  HTTP 状态与 provider 消息，故展示真实原因、且重试按状态分类（永久 401 不再像瞬时
  503 那样被重试）。

- **以 parity 取代手工同步（D5）**：漂移（缺失的 `xiaomi` keyring 条目、过时的
  provider 计数 pin）被修复**并**用测试钉住，使下一个 provider 无法原样回归。

- **合规与 IM 语音，已规划（O4、O5）**：经 `c2pa-rs` 的内容凭证（同时满足 EU AI Act
  Art. 50 的溯源要求与中国《标识办法》的元数据）与第一方 IM 语音回复（一次 transcode
  加一个 voice-segment producer）原则上接受、排为后续工作。语音**克隆**明确排除（ELVIS
  Act）——只有授权音色库可安全分发。

### 休眠判决（W15）

- **删除**：`providers/system.ts`（144 行，仅被自己的测试 import —— 测试掩盖了休眠；
  系统声由 orchestrator 直接驱动）。
- **已修复**：CJK 发音词典匹配。
- **标注/文档化**：`generateSSML` 仅用于装饰性预览（真实合成路径不用它）；
  `selectedMicId` 在 `getUserMedia` 传入 `deviceId` 前是惰性的（激活路径已记）；
  缓存管理 API（`clear`/`getStats`/`getCacheSize`）暂无 UI 消费者。
  `TTSNormalizedError` 未使用，已被 `TTSResponse` 上的结构化字段取代。

## 影响

朗读念出干净散文且更早开始。两个结构上站不住脚的 provider 不再被提供，且不破坏既有
选择。桌宠会说话。失败可操作且被合理重试。子系统现有记录在案的负责人，其 provider
清单有单一真源。音频归属决策保持可逆，因为 Realtime 传输是被预留而非删除。

## 被否决的替代方案

- **修 Edge-TTS（实现 GEC token）而非退役**：为一个战略上已死、靠冒充工作、且在本
  产品自身市场已 403 的路径续命。
- **把 `openai-realtime` 重指向 `gpt-4o-mini-tts` REST**：与 `openai` provider 纯
  重复且有音色兼容风险；退役更干净。
- **为流式 TTS 在 chat 核心加 delta 事件总线**：触碰庞大敏感的 chat 事件循环；对
  store 正在生长的消息做差分零风险得多。
- **基于 viseme 的口型同步**：Live2D 的口型参数是标量张嘴幅度、无法表达元音，且只有
  Azure 暴露 viseme；RMS 包络契合 rig 与业内做法。
