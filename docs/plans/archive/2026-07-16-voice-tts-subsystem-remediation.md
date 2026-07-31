# 语音 / TTS 子系统 — 缺口修复与能力补齐计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是已验证的缺陷或缺口,不是设想)
**范围**: `packages/tts/`、`crates/cognia-tts/`、`lib/tts/`、`components/settings/speech/`、`app/me/speech/`、桌宠出声与口型
**参考 ADR**: 0030(角色包 overlay —— 音色 profile 的来源)、0058(桌宠)、0067(Rust crate 分解 —— `cognia-tts` 由此抽出)、0068(前端包抽取 —— `packages/tts` 由此抽出)、0055/0072(浏览器,仅作 ADR 编号参考)、拟新增 **0075**

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-15-tui-audit-remediation.md` / `2026-07-16-otel-native-telemetry.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                                     | 你必须做什么                                   |
| --------------- | -------------------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 grep / 读代码 / **实跑**核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核                      | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人来拍板                                    | **不要默默替它做决定**,见 §6                   |

### 0.2 证据标准(不可妥协)

**本仓已经吃过两次「假零」的亏**(见 OTel 计划 §0.2):`rg` 的空结果和真正的零匹配长得一模一样。本次调研**又差点吃第三次** —— 作者一度用

```
rtk grep -n -i "tts\|speech\|voice" CLAUDE.md
```

得到空输出,险些据此写下「CLAUDE.md 无语音条目」。**该结论最终为真,但当时的证据是不合格的。** 补跑阳性对照后才可采信:

```
rtk grep -c -i "Tauri" CLAUDE.md        # → 29   (工具在工作)
rtk grep -c -iE "tts|speech|voice" CLAUDE.md   # → 0    (零是真的)
```

**因此:凡本文出现「零 / 不存在 / 未使用」的主张,均已跑阳性对照。你复核时请照做。**

> 另一个本次实测到的坑:`rtk grep` 会把 `\|` 翻译成 `|` 交给 rg(报错信息里能看到 `(?:async speak|speak()`),所以 `\|` **在 rtk grep 下是工作的**;但 `speak(` 这类含正则元字符的模式会直接 parse error。要么 `-F`,要么转义。

### 0.3 业内对标的引用纪律

§1.3 与 §3 中所有关于外部产品/模型/许可证的主张一律 **[AGENT]**,来源见 §7。其中 **6 条会直接改变技术选型**(Piper 许可证、sherpa-onnx 的 GPL 静态链接、Live2D 无 viseme、macOS AEC 约束、OpenAI 定价、Edge-TTS 中国大陆 403),**动手前必须自行复核**。研究 agent 自报 DeepWiki 在 4 项以上主张上给出了错误信息(编造 Pipecat 帧名、否认 lobe-chat 移除 TTS、把 Edge 端点误标为 Azure、虚构 Cherry Studio 的 TTS),已改由 raw source 复核 —— 这提示**二手结论在本主题上的错误率很高**。

---

## 1. 研究结论(先读这节,它推翻了两个相反方向的默认假设)

### 1.1 假设一「语音只是个设置面板」—— 错

**核心是真材实料的。** `packages/tts/` 约 12k 行 / 26 个源文件,11 个 provider **全部真实实现,无 stub**;适配器注册表把四处并行 switch 收敛成一个 provider 一个对象;取消按 `requestId` 仲裁;流式路径有独立的 `PcmPlayer`(按 `nextStartTime` 排程,不会排到过去);IndexedDB 音频缓存(24h TTL / 100MB / 过期优先淘汰);云端失败可回退系统音而不是整句失败。包内 24/26 文件有同址测试,381 个测试通过。

**chat 侧的接线也全活**,不是死代码 [AGENT]:

| 表面           | 文件:行                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| 朗读按钮       | `components/chat/message-renderer.tsx:554` → `read-aloud-button.tsx`               |
| 自动朗读       | `components/chat/message-list.tsx:90` → `hooks/media/use-chat-auto-play-tts.ts:72` |
| 全局播放条     | `app/layout.tsx:330`                                                               |
| 移动端动作面板 | `components/mobile/chat/message-action-sheet.tsx:342`                              |
| 角色音色       | `lib/tts/speak-chat-message.ts:54` `resolveCharacterVoice()`                       |

`ttsEnabled` 有 4 处真实门控(含 `tts-orchestrator.ts:112` 的硬 return);`ttsAutoPlay` 在 `use-chat-auto-play-tts.ts:57` 真实生效 —— 该 hook 的注释自陈是来修一个**曾经的休眠**的,说明这条路径已经被修过一次。

### 1.2 假设二「那就没什么大问题了」—— 更错

**三个致命项,都已实跑证实:**

**(a) 流水线根本不流式 [CONFIRMED]。** `speak(text: string)` 收的是完整字符串。`splitTextForTTS` 的第一个分支就是:

```ts
while (remaining.length > 0) {
  if (remaining.length <= limit) { chunks.push(remaining.trim()); break }   // ← 正常回复走这里
  ...
}
```

`limit` 是 provider 的 `maxTextLength`(4096–40000)。**任何正常长度的回复都只切成 1 块**,`runChunkPipeline` 的 depth-1 预取永不启动。结论:**首音延迟 = LLM 全部生成完 + 全文合成完**。现有的预取优化的是错误的轴。

**(b) 文本预处理是坏的 [CONFIRMED —— 实跑复现]。** 用 `tsx` 直接调 `normalizeTextForTTS`:

````
"# Introduction\nHello there."           → "number Introduction Hello there."
"Here:\n```js\nconst x = 1;\n```\nDone." → "Here: js const x equals 1; Done."     ← 代码块被朗读
"Items:\n- first\n- second"              → "Items: - first - second"
"Great job 🎉🚀 well done"                → "Great job 🎉🚀 well done"              ← emoji 原样进 provider
````

根因是 `packages/tts/src/tts-text-utils.ts` 内的**执行顺序**:

- `:55` `text.replace(/\s+/g, " ")` 先把换行折叠掉 → 下方所有 `^` 锚定的 `/gm` 正则(`:89` 标题、`:90` 列表、`:91` 有序列表)**只能匹配 index 0**,列表永远剥不掉。
- `:77` `#` → `" number "` 早于 `:89` 的标题剥离 → **标题读成「number Introduction」**。
- `:81` `\*` → `""` 早于 `:85-86` 的粗/斜体规则 → 那两条是**死代码**。
- `:88` 行内代码 ``/`(.*?)`/`` 早于 `:95` 的围栏剥离,且 `.` 不跨行 → 成对吃掉 ` ``` ` 的反引号,**导致 `:95` 永不匹配,代码块整块朗读**。

**(c) 桌宠不出声,而口型的壳已经建好了 [CONFIRMED]。** `components/pet/ lib/pet/ stores/pet/ hooks/pet/ types/pet/` 内 `tts|TTS` **零命中** [AGENT]。但:

- `lib/pet/animation/motion-spec.ts:9` — `PetMouthShape = "neutral" | "smile" | "grin" | "open" | "frown" | "flat" | "o"` —— **7 形状口型 rig 已存在**
- `types/pet/skin.ts:47` — 注释原文:_"A speech bubble is showing — skins may animate the mouth (lip flap)."_
- `components/pet/skins/svg-skin.tsx:195` — `<PetMouth shape={spec.mouth === "frown" ? spec.mouth : "o"} />` —— **lip flap 已经在跑**

**驱动它的是文字气泡的显示状态,不是声音。** rig 有、接缝有、动画有,唯独没有音频。

### 1.3 业内对标:三条推翻既有直觉的结论 [AGENT]

**(a) 口型同步不要做 viseme。** **Live2D Cubism 在格式上无法表达元音** —— `ParamMouthOpenY` 是标量张嘴幅度,官方 Web SDK 示例就是 RMS → `addParameterValueById`。业内实况:

| 项目                     | 口型驱动                                      | 有元音                                                                        |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------- |
| Open-LLM-VTuber          | 客户端 RMS                                    | 无                                                                            |
| Amica                    | **峰值**振幅 → 硬编码 `lipSync("aa", volume)` | 无                                                                            |
| AIRI                     | wlipsync(MFCC→AEIOU)                          | **有** —— 但需 Unity 做标定档,故几乎无人用;其 Live2D 驱动又把元音权重塌回标量 |
| lobe-tts / cherry-studio | 无口型                                        | —                                                                             |

**最扎心的佐证**:Open-LLM-VTuber 的**后端**已预计算每 20ms RMS 并放进 `AudioPayload` 的 `volumes` 字段 —— **前端从来不读**,自己重算。这条数据通路被反复建好又反复废弃。**你们的 `wordBoundaryEnabled:false` + 丢弃 metadata 帧,是同一个病的同一个阶段。**

→ **推论:W12 用 RMS 包络,不要为口型去修 word boundary。**

**(b) Edge-TTS 该退役,不是该修。** 其 token 是 `SHA256(取整的 Windows filetime ticks + "6A5AA1D4EAFF4E9FB37E23D68491D6F4")`,常量**扒自 Edge 浏览器**,还需伪造 UA 与 `Origin: chrome-extension://…`。**没有可接受的 ToS,没有可申请的 key —— 访问前提是冒充 Microsoft Edge。** 且 `rany2/edge-tts#286` 是「**仅中国大陆 403**」—— 恰是本产品的市场。补 GEC 只是把「现在就坏」换成「下次轮换再坏」。

**(c) macOS AEC 会锁死架构,而现在还是免费选择。** macOS 的 VPIO **必须同时拥有输入和输出流**(回声消除需要 render 流作参考)。→ **WebView 播放 + Rust 采集 = AEC 永远不可能工作**。而这正是「自然而然」会走到的架构(`<audio>` 播放最省事,cpal 采集是 Tauri 直觉)。**因为 Rust 侧现在是空的(`cpal|rodio|whisper|vad|microphone` 全仓零命中 [AGENT]),这仍是一次免费决策。** 见 **[OPEN] O1**。

### 1.4 治理缺口 [CONFIRMED]

- **没有任何 ADR 拥有这个子系统。** 语音只在 0030(角色音色 overlay)、0067(crate 被搬走)、0068(包被搬走)中作为**「被搬运的对象」**出现,**没有一篇 ADR 记录过它的设计决策**。
- **CLAUDE.md 的 Subsystem Map 无此行** —— `tts|speech|voice` 零命中(阳性对照 `Tauri`=29)。
- **provider 清单已漂移成 4 份** [AGENT]:`packages/tts/src/types.ts`(11)、`crates/cognia-tts/src/keyring.rs`(7,缺 xiaomi)、`app/me/speech/page.tsx:56`(自己硬编码 10 个,漏 `openai-realtime`,docstring 还指向已失效的 `lib/claude/types.ts`)、`STT_LANGUAGES`(8 vs 包内 13)。
- **ADR 编号**:0073(chromium-cookie-import)、0074(otel-native-telemetry)**均已落地**,下一个空号是 **0075**。

---

## 2. 已决策

| #      | 决策                                                                               | 理由                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **口型走 RMS 包络驱动现有 7 形状 rig**,不做 viseme,不为口型去修 Edge word boundary | §1.3(a):Live2D 格式无法表达元音,业内(除 AIRI)全用 RMS/峰值。现有 rig + `skin.ts:47` 的 lip-flap 接缝直接可用。真 viseme 只有 Azure 能给,而 Azure 不在 11 个 provider 里,且要牺牲 HD 音色 |
| **D2** | **`realtime.rs` 从 speech-to-speech 模型改为 `gpt-4o-mini-tts`**                   | 纯 TTS 用 s2s 模型:**$64/1M 音频输出 vs $12** [AGENT],且靠 prompt(`VERBATIM_INSTRUCTION`)压制模型能动性 —— 用错工具。s2s 该留给真正的语音对话(见 O1)                                     |
| **D3** | **orchestrator 改吃 token 流,两级分隔符**                                          | §1.2(a):首音延迟现在等于全文合成完。首片段用宽集合 `.?!;:,\n…)]}。` 抢延迟,之后窄集合 `.?!\n…。` 保韵律(参考 stream2sentence)                                                            |
| **D4** | **P0 全部修完再动 P1** —— 止血优先于架构                                           | W1/W4/W5 是「用户已经在受影响」的活 bug(代码块被朗读、取消失灵、缓存碰撞播错音频),而 P1 是延迟优化。红基线(W2)不清,后续 PR 无法判断自己是否引入回归                                      |
| **D5** | **同 PR 补 parity 测试,不只修数据**                                                | xiaomi 缺失(W3)的成因是**两侧清单手工同步且无测试钉住**。只加一行 `"xiaomi",` 而不加测试,下一个 provider 会原样再犯                                                                      |

---

## 3. 工作项

### P0 — 止血(活 bug,用户已受影响)

#### W1. `normalizeTextForTTS` 执行顺序 [CONFIRMED]

- **问题**:代码块被整块朗读;markdown 标题读成「number X」;列表符号原样读出;粗/斜体两条规则是死代码。
- **证据**:§1.2(b) 的实跑输出。`packages/tts/src/tts-text-utils.ts:55/77/81/88/89-91/95`。
- **修法**:重排为 **① 剥离结构(围栏 → 行内代码 → 标题 → 列表 → 粗斜体) → ② 折叠空白 → ③ 符号替换**。`:55` 的 `\s+→" "` 必须**下沉到结构剥离之后**,否则 `/gm` 锚点全废。删掉 `:85-86` 两条已被 `:81` 架空的死规则(或把 `:81` 后移使其复活 —— 二选一,不要都留)。
  - ⚠️ **别顺手改 emoji**:emoji 直通是**独立缺口**(见 W15),不要混进这个 commit。
  - ⚠️ **符号替换会往中文里注英文**:`&`→" and "、`%`→" percent "、`#`→" number " 在中文文本里是错的。本项只修顺序;语言感知的符号替换归 W15。
- **验收**:新增同址测试,把 §1.2(b) 那 4 个 case 全部钉死(含 emoji 现状,以免 W15 静默改变行为)。`rtk pnpm test -- packages/tts/src/tts-text-utils.test.ts` 绿。

#### W2. `types.test.ts` 红基线 [CONFIRMED]

- **问题**:`rtk pnpm test -- packages/tts/src/types.test.ts` → **2 failed, 6 passed**。目录钉死 10 个 provider,实际 11 个(`openai-realtime` 上线时未更新 pin)。
- **证据**:实跑输出 `Expected length: 10 / Received length: 11 / Received array: ["system","edge","openai","openai-realtime",…]`。工作树对这些路径 clean → **既有问题,非本次引入**。
- **修法**:改 pin 为 11。**顺带修 docstring 漂移**:`tts-orchestrator.ts:2` 写「all 9 providers」、`types.ts:3` 写「Supports 9 providers」 [AGENT]。
- **验收**:该 suite 绿。**这一项必须最先做** —— 否则后续任何 PR 都无法用「测试是否变红」判断自己。

#### W3. `xiaomi` keyring parity [CONFIRMED]

- **问题**:桌面端小米 TTS 的 key **每次 refresh / 重启后被静默丢弃**。
- **证据**:`crates/cognia-tts/src/keyring.rs:15-23` 的 `KNOWN_PROVIDERS` 只有 7 个(openai/google/elevenlabs/lmnt/hume/cartesia/deepgram),**无 xiaomi**;而 `lib/tts/keyring.ts:15/25/46-47` 有,`packages/tts/src/types.ts:626/640` 也有。因 `validate_provider` 只查非空(`keyring.rs:25-30`),set/get **都能成功** —— 但 `tts_keyring_list_providers()` 永不返回它,而 Tauri 分支的 `loadAllProviderKeys()` **只遍历 list 的结果**,`set({providerKeys})` 整体覆盖 → 静默丢失。
- **修法**:`keyring.rs:22` 后加 `"xiaomi",`。**并按 D5 加 parity 测试**:Rust 侧断言 `KNOWN_PROVIDERS` 等于 TS 的 `KEYRING_PROVIDER_IDS`(可用生成的 fixture 或在 TS 侧加一个读 Rust 源的测试 —— 二选一,写清理由)。
  - 顺带评估:`validate_provider` 不校验白名单 → 任意字符串可在 `com.cognia.tts` 命名空间写条目。收紧会破坏现有测试(`keyring.rs:86` 用了 `"cognia_test_provider_empty"`),**属于 W15 范畴,本项不动**。
- **验收**:`rtk cargo test -p cognia-tts` 绿;手工验证小米 key 重启后仍在。

#### W4. `realtime.rs` 取消竞态 [CONFIRMED]

- **问题**:握手窗口内的取消**丢失,且此后该请求永不可取消**,音频继续合成并推给前端。
- **证据**:`realtime.rs:103-108`:
  ```rust
  pub fn tts_realtime_cancel(request_id: String) {
      if let Some(cancel) = cancels().lock().remove(&request_id) {   // ← 先 remove
          cancel.notify_waiters();                                    // ← 不存 permit
      }
  }
  ```
  tokio 的 `notify_waiters()` **不存 permit**,只唤醒此刻已注册的 waiter。而 waiter 只在 `realtime.rs:148` 的 `select!` 内注册,之前要先跑完 `connect_async` + 3 次 `ws.send`(`:130-145`,网络握手,最慢的一段)。窗口内到达的 cancel:条目已被 `remove` → 通知丢失 **且再也取消不了**。前端 `openai-realtime.ts:46-53` 正是在 abort 时立刻 invoke cancel → **「点了马上停」必然命中此窗口**。
- **修法**:改用 `tokio_util::sync::CancellationToken`(存状态,不丢通知),或 `notify_one()`(存 permit)。**次要同修**:每轮 `select!` 重建 `notified()` future,分支切换间隙同样丢通知 —— `CancellationToken` 一并解决。
  - 顺带:取消时只发 `Message::Close`(`:150`),**未发 `response.cancel`** → 服务端可能仍按整次 response 计费 [AGENT]。若 D2 落地(改用 `gpt-4o-mini-tts`),此路径整体消失 —— **确认 W4 与 D2 的先后**,见 §5。
- **验收**:新增测试覆盖**注册 → 通知 → 退出**全链路(现有 10 个测试只覆盖「未注册 id 不 panic」,正因如此才没发现这个竞态)。

#### W5. 缓存 key 碰撞 [CONFIRMED]

- **问题**:缓存 key 是 32 位 djb2 → `Math.abs()` 后约 31 位。**约 6.5 万条即生日碰撞 → 播出错误的音频**(不是缓存未命中,是播错内容)。
- **证据**:`packages/tts/src/tts-cache.ts:48-54`:`let hash = 0; hash = (hash << 5) - hash + str.charCodeAt(i); hash |= 0;` → `` `tts_${Math.abs(hash).toString(36)}` ``。缓存上限 100MB,达到 6.5 万条完全现实。
- **修法**:`crypto.subtle.digest("SHA-256", …)` → hex。**注意 key 构造本身是对的**(`:34` 已把 text + provider + provider 专属 `cacheKeyFields` + 发音词典一起折进去),只换哈希函数。**旧 key 全部失效** → 需要一次性清理或版本前缀(`tts2_`),**不要留脏数据**。
- **验收**:同址测试;确认 DB 迁移/清理路径不炸。

#### W6. `detectLanguage` 日语误判 [CONFIRMED]

- **问题**:**含汉字的日语(即绝大多数日语)被判成 `zh-CN`**。
- **证据**:`tts-text-utils.ts:125-138`:
  ```ts
  export function detectLanguage(text: string): string {
    if (/[一-鿿]/.test(text)) {          // ← 汉字先判
      if (/[㄀-ㄯㆠ-ㆿ]/.test(text)) return "zh-TW"   // ← 注音符号,真实文本基本不出现
      return "zh-CN"
    }
    if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja-JP"   // ← 永远轮不到含汉字的日语
    ...
  ```
- **修法**:**假名优先于汉字**(有假名 → ja-JP);zh-TW 的注音检测换成繁体字集或直接删掉(它现在等于死分支)。
  - ⚠️ **但先确认这个函数值不值得修**:`detectLanguage` **当前无任何 TTS 路径调用** [AGENT] —— `SpeechSynthesisUtterance.lang` 是从 `sttLanguage`(**麦克风识别语言**)取的(`tts-orchestrator.ts:624`)。所以真正的 bug 是**「中文回复被英文音色朗读」**,而修 `detectLanguage` 只是修了一个没人叫的函数。**本项应连同接线一起做,否则就是在给死代码抛光**(见 W15 对 dormancy 的态度)。
- **验收**:测试钉死 `"今日は良い天気ですね"` → `ja-JP`、`"你好"` → `zh-CN`;且 orchestrator 真的用上它。

---

### P1 — 架构(延迟与成本)

#### W7. orchestrator 吃 token 流 【D3】【收益最大】

- **问题**:首音延迟 = LLM 全部生成完 + 全文合成完。见 §1.2(a)。
- **证据**:`speak(text: string)` 签名 + `splitTextForTTS` 的 `<= limit` 单块分支 + `runChunkPipeline` 需要预先知道 `count`。
- **修法**:新增流式入口(**保留** `speak(string)` 兼容现有 4 个调用点),内部走 HOLD/SPLIT/REJECT 分类器:
  - 首片段:宽分隔符 `.?!;:,\n…)]}。-`,`minimum_first_fragment_length≈10`,`force_first_fragment_after_words≈30`
  - 之后:窄分隔符 `.?!\n…。`,`minimum_sentence_length≈10`
  - **保序投递**:并行合成必须按序播放(现有 `PcmPlayer` 的 `nextStartTime` 排程可复用)
- **依赖**:**必须在 W1 之后** —— 否则会把「代码块被朗读」按句切开、更早地读出来,劣化更明显。
- **验收**:量首音延迟(TTFA)前后对比,写进 PR 描述。**不要只跑测试就宣称完成**(见 §4)。

#### W8. `realtime.rs` 现代化 【D2】

- **问题**:成本 5.3×;模型 id 停在旧的 `gpt-realtime`;协议形状自相矛盾。
- **证据** [AGENT]:同时发 `OpenAI-Beta: realtime=v1`(beta 头)与 `session.type:"realtime"`(GA 形状) —— GA 文档要求去掉该头。当前旗舰是 `gpt-realtime-2.1`(2026-07-06 发布)。定价:s2s 音频输出 **$64/1M** vs `gpt-4o-mini-tts` **$12**。
- **修法**:按 D2 改用 `gpt-4o-mini-tts`(REST,走现有 `proxyFetch`)。**注意它支持 `instructions` 参数**(steer 口音/情绪/语速),而 `tts-1`/`tts-1-hd` **完全忽略该参数** —— 别选错模型。格式选 **wav/pcm 最低延迟**(mp3 需编码器缓冲帧)。
  - **`VERBATIM_INSTRUCTION` 那套 prompt 压制随之消失** —— 这是本项的主要收益之一。
  - ⚠️ **若 O1 决定要做实时语音对话,`realtime.rs` 的 s2s 链路应保留但改作它用**,而不是删除。**先拍 O1 再动手。**
- **验收**:成本对比 + 实听质量对比。

#### W9. Edge-TTS 退役 【依赖 [OPEN] O2】

- **问题**:见 §1.3(b)。`edge.rs` **不发 `Sec-MS-GEC` 头** [CONFIRMED —— 阳性对照:同命令下 `TrustedClientToken` 命中 3 处,`Sec-MS-GEC` 零命中],故该路径**要么已在 403,要么距下次轮换失效只差一次**。
- **修法**:**取决于 O2**。若退役:从 `ORDERED_TTS_PROVIDERS` 移除,UI 标注,保留代码一个版本再删。若保留:**必须**实现 GEC(`SHA256(roundedTicks + TrustedClientToken)`,300s 边界取整,大写 hex)+ `Sec-MS-GEC-Version` 头,**并在 UI 明示「随时可能失效、中国大陆不可用」**。
- **不要**:在没拍 O2 的情况下「顺手补个 GEC」。那是在给一个战略上已死的 provider 续命。

#### W10. `proxy.rs` 加固 [AGENT]

- **问题**(逐条独立,可拆 commit):
  1. **无 URL 白名单 → 通用 SSRF 原语**(`proxy.rs:82`)。命令名叫 tts,能力是任意方法 + 任意 header + 任意 host,可打 `169.254.169.254`、`localhost:*`,并拿回完整响应体。
  2. **零 timeout**(`Client::builder()` 未设 `.timeout()`/`.connect_timeout()`)→ 命令可永久 pending。**`edge.rs:125` 与 `realtime.rs:147` 的接收循环同样零 timeout**。
  3. **全缓冲**(`response.bytes()`),`stream` feature 白开;+33% base64 内存放大,无大小上限 → 可 OOM。
  4. **每次调用重建 `Client`** → 丢连接池 / TLS 会话复用,每句话重做握手。
  5. **错误信息可能泄密**:`format!("send failed: {e}")` —— reqwest 的 Display 带 URL,而 Gemini 用 `?key=` → **key 进日志/toast**。
  6. **注释说谎**:`proxy.rs:4-7` 自称「keeps the key in the Rust process」,**实际相反** —— key 由前端从 keyring 取出、灌进 Zustand `providerKeys`、再塞进 header 传下来(`host-bindings.ts:51`)。**要么改注释,要么把 key 注入下沉到 Rust(按 provider id 从 `secret_store` 取)** —— 现状会误导后续维护者做出错误的安全假设。
  7. `edge.rs` / `realtime.rs` **绕过 `cognia_net::proxy_config`**(仅 `proxy.rs:63` 使用)→ 代理网络下表现为「部分 provider 可用」这种极难诊断的症状。
- **修法**:1/2/5/6 优先(安全 + 可靠 + 诚实);3/4 是性能;7 需确认 WSS 走代理的实现成本。
- **验收**:三个网络函数(`edge::synthesize` / `realtime::synthesize` / `tts_proxy_fetch`)**目前 0 测试** [AGENT] —— 加 mock WS/HTTP server(`wiremock` 或本地 tungstenite)。**Edge 二进制帧解析(`edge.rs:128-141`)是全 crate 风险最高的字节级逻辑,一个测试都没有** —— 若 O2 决定保留 Edge,必须补。

---

### P2 — 产品(桌宠出声)

#### W11. 桌宠接入 TTS 【本计划的产品核心】

- **问题**:一个有 Live2D/SVG 桌宠的产品,桌宠**不会说话**。`components/pet/ lib/pet/ stores/pet/ hooks/pet/ types/pet/` 内 `tts|TTS` 零命中 [AGENT]。`speakAsPet`(`hooks/pet/use-pet-speak.ts:26`)只吐文字气泡。
- **修法**:把 `speakAsPet` 的文本接到 `ttsOrchestrator.speak`,复用 `resolveCharacterVoice`(角色音色已在 `lib/tts/speak-chat-message.ts:54` 工作)。
- **依赖**:**W7 之后做收益最大**(桌宠对首音延迟最敏感 —— 它是「即时反应」的交互)。
- **验收**:实机听。**不接受「测试通过」作为完成证据**(§4)。

#### W12. RMS 包络驱动现有 7 形状口型 【D1】

- **问题**:rig(`motion-spec.ts:9`)、lip-flap 接缝(`skin.ts:47`)、动画(`svg-skin.tsx:195`)**全部已存在**,驱动源是文字气泡而非声音。
- **修法**:`AnalyserNode` → 每帧 RMS → 映射到 `PetMouthShape`。7 形状比业内典型的「单一标量」更富:建议 RMS 阈值分档到 `neutral/flat/o/open`,**保留 `smile/grin/frown` 给情绪层**(不要让口型和表情抢同一个通道)。
  - ⚠️ **`<audio>` 路径与 `PcmPlayer` 路径要分别接** —— 前者用 `createMediaElementSource`,后者已有 AudioContext 可直接挂 Analyser。
  - ⚠️ **不要**为此去改 `edge.rs:160` 的 `wordBoundaryEnabled`(D1)。
- **依赖**:W11。
- **验收**:实机看口型是否跟声音走。

---

### P3 — 缺口收口

#### W13. Rate/Pitch 滑块的虚假承诺 [AGENT]

`ttsRate`/`ttsPitch` **唯一的运行时读者**是 `tts-orchestrator.ts:621-622` 的 `playSystemChunk` —— **只对 `system` 生效**。云端 provider 各用自己的字段(`openaiSpeed`/`edgeRate`/`lmntSpeed`/`cartesiaSpeed`)。但 `tts-card.tsx:272/288` 与 `app/me/speech/page.tsx:270/289` **对全部 11 个 provider 无条件渲染**。→ 选 OpenAI 拖 Rate = 什么都不会发生。**修法**:按 provider 门控(`system` 才显示),或与 provider 专属 speed 字段合并成一个。**只有 `ttsVolume` 是真正通用的。**

#### W14. `getTTSError` 吞掉真实原因 [AGENT]

`getTTSError(type, details)` 把 `details` 塞进独立字段,而所有 provider 都取 `.message` → **真实原因(invalid api key / quota exceeded)被算出来后扔掉**,用户永远只看到「TTS API returned an error」。更糟:`retry.ts:13` **依赖这个塌缩**,靠字符串匹配判可重试性 → **永久 401 与瞬时 503 无法区分,被重试 3 次带退避**。**修法**:保留结构化 error(至少 `{type, status, providerMessage}`),retry 改按 status 分类。**这是一个改动会牵连两处的项,不要只改一半。**

#### W15. Dormancy 清理 —— 按 Rule 7 的三轴逐个判 [AGENT]

本仓 Rule 7:_「意图性休眠必须在类型上有文档 + UI 上标注 inert + 测试钉住。三缺一即潜在 bug。」_ 以下**每一项都要显式判决「激活 / 删除 / 标注为有意休眠」,不许留白**:

| 对象                                                                                                                                                       | 现状                                                                                                     | 备注                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectedMicId`                                                                                                                                            | 两处可配(`stt-card.tsx:104`、`voice-controls.tsx:179`)、持久化、**无人消费**                             | Web Speech API 无设备选择;`getUserMedia({audio:true})` **没传 `deviceId`**。→ 选麦克风**完全没用**                                                                        |
| `providers/system.ts`                                                                                                                                      | 整个文件(144 行 / 10 个导出)**死代码**,但**有测试**                                                      | 注册表不 import 它,barrel 不导出它,唯一 importer 是它自己的测试。**测试反而掩盖了休眠** —— 这正是 Rule 7 要防的                                                           |
| MediaRecorder 回退                                                                                                                                         | `speech-input.tsx:308` 在 `!onAudioRecorded` 时禁用按钮,而 `voice-controls.tsx` 从不传它                 | **已在注释里文档化**(2/3 轴),缺测试钉住                                                                                                                                   |
| `isProviderKeyMissing` / `keyringProviderFor`                                                                                                              | 零调用点                                                                                                 | 「provider key 缺失」的检查存在,但**没有任何界面据此警告用户**                                                                                                            |
| 缓存管理 API                                                                                                                                               | `ttsCache.clear()` / `.getStats()` / `.getCacheSize()` **无 UI 消费者**                                  | 有 `ttsCacheEnabled` 开关,但**没有大小显示、没有清理按钮** —— 100MB IndexedDB 用户既看不到也清不掉                                                                        |
| `estimateSpeechDuration` / `getWordCount` / `getEdgeVoicesByLanguage` / `providerRequiresApiKey` / `getApiKeyProvider` / `getSpeechLanguage` / `isCJKText` | 零调用点                                                                                                 |                                                                                                                                                                           |
| `generateSSML`                                                                                                                                             | 唯一调用者是**装饰性预览**                                                                               | 且预览是错的:`tts-card.tsx:41-43` 给 Edge 传 `rate/pitch/volume: undefined` → 渲染默认值,**与用户实际的 `edgeRate`/`edgePitch` 无关**;`system` 根本不用 SSML 却也给它预览 |
| SSML 双重转义                                                                                                                                              | `preprocessTextForProvider` 转义一次,`generateSSML` 再转义一次 → `&` → `&amp;amp;` [AGENT]               | 且 `generateSSML` 发 `rate="0%"` 缺 `+` 号(Rust 侧正确地默认 `"+0%"`)                                                                                                     |
| 发音词典 CJK 失效                                                                                                                                          | `applyPronunciationDictionary` 用 `\b${word}\b` —— **JS 的 `\b` 对 CJK 无效** → 中文词条永不匹配 [AGENT] |                                                                                                                                                                           |
| emoji 直通                                                                                                                                                 | 无任何处理,原样进 provider [CONFIRMED]                                                                   | 无 provider 文档化 emoji 行为 → 责任在应用侧                                                                                                                              |
| URL 处理                                                                                                                                                   | `tts-text-utils.ts:94` **整条删除** [AGENT]                                                              | 静默丢语义;业内做法是展开成可读形式                                                                                                                                       |

#### W16. IM 语音回复 —— 差一次 transcode 和一个 producer [AGENT]

**发送侧全实现了**:`lib/connectors/adapters/discord/voice-upload.ts:40`(`discord/index.ts:513` 调用)、`wecom/serialize.ts:128`、`onebot/segments.ts:341` 都能发 `{type:"voice"}` segment。**但第一方没有任何代码产出 voice segment** —— `a2ui-to-segments.ts` 只出 `markdown`/`text`/`a2ui`,`surface-builder.ts:198` 只传非 voice 单 segment。**唯一够得着的路径是插件手搓 `OutboundRequest`。** 这是本仓的经典形态:**完整实现、有测试、第一方不可达。**

而且**格式对不上**:Lark 要 **Ogg/Opus**(`file_type:"opus"`、`msg_type:"audio"`、`duration` 毫秒、≤30MB),官方文档给的命令是 `ffmpeg -i src.mp3 -acodec libopus -ac 1 -ar 16000 out.opus`。你们只出 **MP3**(edge)和 **PCM16**(realtime) —— **两个都不能直接当 Lark 语音消息发**。

→ **「用语音回复 IM 的语音消息」缺的是:一次 transcode + 一个 producer。** 这是投入产出比很高的一个产品功能,但**它是新功能,不是修 bug** —— 需要产品先确认要不要做,见 O5。

#### W17. C2PA 内容凭证 【合规,有硬期限】[AGENT —— 全节须复核]

⚠️ **EU AI Act Art. 50 适用日 2026-08-02 —— 距今 17 天**,且未被 Digital Omnibus 推迟(推迟的是 high-risk 到 2027/2028)。现有 TTS 链路**无任何 provenance / 水印**。

- **为什么是 C2PA 而不是水印**:`c2pa-rs` 是 **MIT OR Apache-2.0、v0.89.x、MSRV 1.88、wav/mp3/m4a/flac 读写、无 Python/GPU/权重依赖** → **在 `crates/cognia-tts` 里是天级工作量**。且**一次满足两个法域**:中国《标识办法》Art. 5 强制的是**元数据**(提供者名称/编码 + 内容编号 + 属性信息),只「鼓励」水印 —— 正好是 C2PA manifest 的形状。**顺序:C2PA 优先,水印其次。**
- ⚠️ **两个硬约束**:(1) 桌面应用把签名私钥放在用户机器上 → **结构上不可能达到高 C2PA assurance level**,只能自签并接受 `signingCredential.untrusted`。(2) AudioSeal 虽是完整 MIT(含权重),但**是 PyTorch,无官方 Rust 绑定、无验证过的 ONNX 导出** → **别在排期里假设它可用**,要先做导出原型。
- ⚠️ **水印挡的是意外,不是对手**:同行评审(SoK 2503.19176)结论是无一方案足够鲁棒;覆写攻击黑盒成功率约 100%(AAAI 2026),且能**伪造而非仅抹除**。→ **永远不要因为「没检出水印」就推断「这是人录的」。**
- **[OPEN] O4 决定要不要在 8/2 前做** —— 取决于是否面向欧盟。

#### W18. 治理:ADR-0075 + Subsystem Map [CONFIRMED]

- 落 `docs/content/docs/en/adr/0075-voice-tts-subsystem.md`(+ `zh/`),记录 **D1–D5 与 O1 的最终决议**。**下一个空号是 0075**(0073=chromium-cookie-import、0074=otel-native-telemetry 均已落地)。
- CLAUDE.md 的 Subsystem Map 加一行:
  ```
  | 语音 / TTS | `packages/tts/`, `crates/cognia-tts/`, `lib/tts/`, `components/settings/speech/`, `app/me/speech/` | — | 0075 |
  ```
- **收敛 4 份 provider 清单到 1 份**:`app/me/speech/page.tsx:56` 改 import `ORDERED_TTS_PROVIDERS`(并删掉指向已失效 `lib/claude/types.ts` 的 docstring);`STT_LANGUAGES`(8)并入 `SPEECH_LANGUAGES`(13);Rust `KNOWN_PROVIDERS` 由 W3 的 parity 测试钉住。
- **测试缺口**(Rule 3:`components/**` 必须同址测试)[AGENT]:`tts-card.tsx`(389 行)**无测试**、`stt-card.tsx`(131 行)**无测试**、`speech-section.tsx` **无测试**、`provider-config.tsx`(748 行)**仅测了 11 个配置中的 1 个**。
- **i18n 违规** [AGENT]:`provider-config.tsx:466-475` 的 `CARTESIA_EMOTION_PRESETS` 标签硬编码英文(`"Positive"`/`"Sad"`/…),`:538` 渲染;`:650` 直接渲染 `{s.tag}` —— 小米音色的中文字面量(`[开心]`/`[粤语]`)会展示给英文用户,而 `XIAOMI_TTS_STYLES` **明明带着没人用的英文 `name` 字段**(`types.ts:375`)。

---

## 4. 反简化(本仓 Rule 2)

- **不许**用「测试通过」代替实听。TTS 的缺陷绝大多数**测试测不出来**(音色不对、延迟高、口型不同步、中文被英文音色读)。W7/W11/W12 的验收**必须是实机**。
- **不许**只修 `detectLanguage` 而不接线(W6)—— 那是给死代码抛光。
- **不许**只加 `"xiaomi",` 而不加 parity 测试(D5)—— 下个 provider 会原样再犯。
- **不许**在没拍 O2 的情况下给 Edge「顺手补个 GEC」(W9)。
- **不许**把 W15 的休眠项「先留着」。每一项都要有判决。**留白就是下一次审计的输入。**
- **不许**因为 `getTTSError` 的 retry 依赖麻烦就只改一半(W14)。

## 5. 顺序与依赖

```
W2(红基线,最先)
  ├─ W1 ─→ W7 ─→ W11 ─→ W12
  ├─ W3 / W5 / W6            (P0,彼此独立)
  └─ W4 ──(若 O1=做实时对话 则保留 s2s)──→ W8
W9  ← 依赖 O2
W10 ← 独立,可随时插入
W17 ← 依赖 O4(有 8/2 硬期限)
W18 ← 最后,记录已定的决议
```

**W4 与 W8 的先后取决于 O1**:若 O1 决定做实时语音对话,s2s 链路要保留 → W4 必修;若不做,W8 会让 `realtime.rs` 整条消失 → W4 白做。**先拍 O1。**

## 6. 待拍板 [OPEN] —— 不要默默替它做决定

| #      | 问题                                                                                                                                                                     | 为什么现在问                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1** | **音频归属:全 WebView,还是全原生?** macOS VPIO 的 AEC **必须同时拥有输入和输出流** → **WebView 播放 + Rust 采集 = AEC 永远不可能工作**。而这正是「自然而然」会走到的架构 | **Rust 侧现在是空的(`cpal                                                                                                                                                                                                                                                                                                                                                                                                                                            | whisper | vad` 全仓零命中),所以这仍是免费选择。** 一旦 W11/W12 落地,播放就固化在 WebView 侧,实时语音对话的门就关上了。**这是本计划中最不可逆的决定** |
| **O2** | **Edge-TTS 砍还是留?**                                                                                                                                                   | 决定 W9 的形态。砍 = 少一个免费音色源;留 = 接受「冒充 Edge 浏览器 + 中国大陆 403 + 随时失效」                                                                                                                                                                                                                                                                                                                                                                        |
| **O3** | **STT 路线**:保持 Web Speech API / sherpa-onnx streaming zipformer / whisper.cpp?                                                                                        | 现状对 local-first 产品是矛盾的:`SpeechRecognition` **把用户音频送到 Google 服务器**,Linux 下 Tauri 不支持,webview 里脆弱。且 ⚠️ **它是 Safari 应用特性而非 WKWebView 特性 → 旗舰桌面端的麦克风按钮很可能常灭**(**未实机验证,请先确认**)。⚠️ sherpa-onnx 有 **GPL-3.0 静态链接陷阱**:`SHERPA_ONNX_ENABLE_TTS` 默认 **ON** → 链 espeak-ng(GPL-3.0),**没有 cargo feature 能关掉**,即使只用 STT。逃生口是自建 `-DSHERPA_ONNX_ENABLE_TTS=OFF` 并设 `SHERPA_ONNX_LIB_DIR` |
| **O4** | **C2PA 是否在 2026-08-02 前做?**                                                                                                                                         | 取决于是否面向欧盟。⚠️ 研究里有一处对不上:Council 另称宽限期缩到「2026-12-02」,但 8/2 + 3 个月 ≠ 12/2 —— **需查 Official Journal 原文**                                                                                                                                                                                                                                                                                                                              |
| **O5** | **要不要做 IM 语音回复(W16)?要不要做语音克隆?**                                                                                                                          | W16 是新功能不是修 bug。至于克隆:**ELVIS Act 有工具提供方条款** —— 分发「主要目的是生成特定可识别个人声音」的工具,**民事 + 刑事**。→ **「授权音色库,而非用户克隆」不是保守,是法律上唯一安全的架构**。各家独立收敛到同一结论(OpenAI 合作方条款直接禁止开发者让终端用户创建音色;ByteDance 故意不放 MegaTTS 3 的 encoder)                                                                                                                                               |

**本地优先不是法律护盾**:EU 50(2) 约束的是 provider;BIPA 附着于采集行为;中国的规定管到应用商店(Art. 7 审核时核验标识材料);ELVIS 附着于**分发工具**本身。

## 7. 参考来源

**代码证据**:全部在正文以 `file:line` 给出。实跑命令:`rtk pnpm test -- packages/tts/src/types.test.ts`、`rtk cargo test -p cognia-tts`(20 passed [AGENT])、`rtk npx tsx -e '…normalizeTextForTTS…'`。

**业内对标(全部 [AGENT],动手前复核)**:
[OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech) · [ElevenLabs latency](https://elevenlabs.io/docs/eleven-api/concepts/latency) · [ElevenLabs best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices) · [Azure viseme](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis-viseme) · [edge-tts drm.py](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py) · [edge-tts #286(中国大陆 403)](https://github.com/rany2/edge-tts/issues/286) · [silero-vad](https://github.com/snakers4/silero-vad) · [smart-turn](https://github.com/pipecat-ai/smart-turn) · [Krisp turn-taking](https://krisp.ai/blog/turn-taking-for-voice-ai/) · [sherpa-onnx CMakeLists](https://github.com/k2-fsa/sherpa-onnx/blob/master/CMakeLists.txt) · [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) · [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) · [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [Live2D LipSync](https://docs.live2d.com/en/cubism-sdk-manual/lipsync/) · [amica lipSync.ts](https://github.com/semperai/amica/blob/master/src/features/lipSync/lipSync.ts) · [airi lip-sync.ts](https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-three/src/composables/vrm/lip-sync.ts) · [Open-LLM-VTuber stream_audio.py](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/utils/stream_audio.py) · [stream2sentence](https://github.com/KoljaB/stream2sentence/blob/master/stream2sentence/stream2sentence.py) · [c2pa-rs](https://github.com/contentauth/c2pa-rs) · [CAC 标识办法全文](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm) · [Watermarking SoK](https://arxiv.org/abs/2503.19176) · [Feishu 语音消息](https://open.feishu.cn/document/server-docs/im-v1/file/create) · [Tauri #11951(macOS getUserMedia)](https://github.com/tauri-apps/tauri/issues/11951)

**研究 agent 自报未能验证**:GB 45438-2025、《深度合成管理规定》Art. 14、Live2D MotionSync 内部机制、AudioSeal 官方 ONNX 导出、Apple SpeechAnalyzer 从 Rust 调用、Kokoro CPU RTF(来源互相矛盾:0.47 RTF vs「2× realtime」)。**这些不要当既定事实用。**
