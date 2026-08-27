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

### 提供商与传输修复（2026-08-08）

- `local-openai-compatible` 是唯一稳定的本地提供商 ID，不捆绑任何引擎。LocalAI、
  Kokoro-FastAPI、Piper 或其他服务只有在实现 OpenAI 兼容的 `POST /audio/speech`
  时才能使用。该协议没有通用音色发现接口，因此模型与音色手动填写；可选 API key
  存在 TTS 密钥环中，也不会进入缓存标识。
- 宿主传输仅接受 HTTP(S) 回环目标（`localhost`、`127.0.0.0/8`、`::1`），且禁止
  重定向。桌面端普通云 TTS 也由宿主注入凭据；渲染器只获得当前提供商的凭据存在状态，
  不读取保存的密钥。纯 Web 调用仍是受 CORS 与安全警告约束的尽力模式。
- 文本进入任何云 TTS 适配器前，应用宿主都会执行共享的出站 PII 门禁；不安全文本返回
  结构化 `pii-blocked` 失败。设备系统 TTS 与仅允许回环的本地提供商不会离开设备，因此
  不经过该云端边界。
- 缓冲式适配器接受 `AbortSignal` 与原生请求 ID。`stop()` 会通过 `tts_proxy_cancel`
  取消当前合成、重试退避和预取；取消或过期结果不能播放，也不能写入缓存。缓存边界保留
  完整的结构化 `TTSResponse`，且只缓存成功音频。
- 缓冲式 HTTP 提供商不再宣称传输流式。为兼容旧设置保留 `ttsStreamingEnabled`，但其
  含义是“预加载下一段”。移动端播放始终解析为设备系统 TTS；移动端选择云提供商只配置
  桌面宿主。
- 普通缓冲式选择器移除 raw PCM。旧 PCM 设置归一化为 MP3；无头 PCM 返回结构化的
  不支持格式错误。MIME 从 `Content-Type` 归一化并移除参数；只有通用二进制响应才回退
  到所选格式。
- ElevenLabs 加载真实账户 voice ID，同时保留手动 ID 输入。旧名称只有在唯一匹配已发现
  音色时才迁移。提供商测试禁用回退，测试请求期间按钮变为“取消”。

### TTS 收敛与实时语音补齐（2026-08-28）

- `edge` 与 `openai-realtime` 仅作为已弃用的序列化及插件兼容 ID 被接受，二者都归一化
  为 `system`；不再拥有可选描述符、适配器、Rust 传输、Tauri 命令或 ACL 授权。
- `@cognia/tts` 统一维护桌面端与移动端共用的提供商设置描述符。运行时注册表和角色包只
  接受可选择提供商，并完整覆盖 Mistral 与本地 OpenAI 兼容配置。
- 实时对话由独立且共享的 live-voice 子系统承载。全球提供商使用浏览器临时会话；通义
  千问、豆包和百度通过同一个支持代理的原生 WebSocket，并从宿主密钥环读取凭据。退役的
  TTS WebSocket 路径不再复用，也没有重复实现。
- 启动实时语音会停止单例 TTS orchestrator；带音频模态的助手消息不参与自动朗读，避免
  同一实时回复播放两次，手动朗读仍可用。

## 影响

朗读念出干净散文且更早开始。两个结构上站不住脚的 provider 不再被提供，且不破坏既有
选择。桌宠会说话。失败可操作且被合理重试。子系统现有记录在案的负责人，其 provider
清单有单一真源。实时语音与朗读已有明确的音频仲裁；专用 live-voice 路径成为唯一的
语音对语音运行时后，旧 Realtime TTS 传输已删除。

## 被否决的替代方案

- **修 Edge-TTS（实现 GEC token）而非退役**：为一个战略上已死、靠冒充工作、且在本
  产品自身市场已 403 的路径续命。
- **把 `openai-realtime` 重指向 `gpt-4o-mini-tts` REST**：与 `openai` provider 纯
  重复且有音色兼容风险；退役更干净。
- **为流式 TTS 在 chat 核心加 delta 事件总线**：触碰庞大敏感的 chat 事件循环；对
  store 正在生长的消息做差分零风险得多。
- **基于 viseme 的口型同步**：Live2D 的口型参数是标量张嘴幅度、无法表达元音，且只有
  Azure 暴露 viseme；RMS 包络契合 rig 与业内做法。
