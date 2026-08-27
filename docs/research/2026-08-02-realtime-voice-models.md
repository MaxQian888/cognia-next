# Real-time voice model landscape beyond GPT Realtime

Date: 2026-08-02

## Scope

This note distinguishes three categories that are often conflated:

1. **Native speech-to-speech models**: audio is a first-class model input and output, retaining some paralinguistic information such as tone and prosody.
2. **Managed voice-agent pipelines**: a single real-time API orchestrates ASR, a text LLM, TTS, turn detection, and interruption handling.
3. **True full-duplex models**: the model explicitly supports listening and speaking concurrently, rather than merely cancelling output when a new user turn begins.

A bidirectional WebSocket describes the transport. It does not, by itself, prove semantic full-duplex behavior.

## Executive summary

- The strongest direct cloud alternatives to GPT Realtime are **Google Gemini Live**, **Amazon Nova 2 Sonic**, **xAI Grok Speech-to-Speech**, and Alibaba Cloud's **Qwen3.5-Omni/Qwen-Audio Realtime**.
- For a Chinese-language product deployed in mainland China, the practical shortlist is **Qwen-Audio 3.0 Realtime**, **Doubao-Seed-RealtimeVoice**, and Baidu's **audio-realtime** family.
- For an existing OpenAI Realtime integration, **xAI is the lowest-migration-effort option** because it documents OpenAI Realtime API compatibility. Qwen and Baidu use similar event-oriented concepts, but should not be treated as drop-in compatible without an adapter.
- For self-hosting and true full duplex, the most relevant options are **MiniCPM-o 4.5** for Chinese/English, and **NVIDIA PersonaPlex/Moshi** for English-centric research and specialized deployments.
- **ElevenAgents, Deepgram Voice Agent, Azure Voice Live, and Cartesia Line** support production real-time conversations, but are primarily managed orchestration stacks rather than single native audio reasoning models.

## Cloud-native and end-to-end models

| Provider / model                                                         | Architecture and transport                                                                              | Interruption / duplex                                                                                           | Languages                                                                                                          | Tools and notable limits                                                                                                                                                              | Assessment                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Google Gemini 3.1 Flash Live Preview / Gemini 2.5 Flash Native Audio** | Native audio input/output over a stateful WebSocket; also accepts images and text                       | Barge-in supported; do not equate this with true simultaneous full duplex                                       | Official Live API documentation lists broad multilingual support, including Chinese                                | Function calling and Google Search; native-audio sessions are preview; audio-only sessions are limited to 15 minutes per connection, with session-management mechanisms for extension | Best global choice when voice, vision, multilingual behavior, and tools are all required                                            |
| **Amazon Nova 2 Sonic**                                                  | Unified speech understanding and generation through Bedrock's bidirectional streaming API               | Intelligent turn-taking and graceful interruption                                                               | English variants, French, Italian, German, Spanish, Portuguese, and Hindi; no Chinese in the current official list | Function calling, RAG, asynchronous tool handling; 8-minute connection limit with renewal/continuation pattern                                                                        | Strong AWS-enterprise option, but unsuitable when Chinese is mandatory                                                              |
| **xAI Grok Speech-to-Speech (`grok-voice-latest`)**                      | Bidirectional audio/text WebSocket; PCM, G.711, and Opus; OpenAI Realtime-compatible event model        | Server VAD enables natural barge-in; forced messages can be marked uninterruptible                              | 20+ documented languages, including Simplified Chinese                                                             | Function calls, web/X/collection search, remote MCP, custom voices and SIP; currently hosted in `us-east-1`; up to 120-minute sessions                                                | Easiest migration from an OpenAI Realtime implementation and a strong tool-using voice-agent option                                 |
| **Alibaba Qwen3.5-Omni Realtime**                                        | WebSocket realtime omni model with audio/text/image/video inputs and streamed speech/text output        | Voice interruption is documented in the realtime SDK; transport is bidirectional                                | Strong Chinese support and multilingual capabilities                                                               | Plus/Flash variants support function calling and web search                                                                                                                           | Best documented general-purpose Chinese multimodal realtime family                                                                  |
| **Alibaba Qwen-Audio 3.0 Realtime Plus/Flash**                           | End-to-end realtime voice model over a full-duplex WebSocket, with streamed audio/text input and output | Server VAD, semantic `smart_turn`, and push-to-talk; speaker enhancement for noisy duplex conversations         | Official page emphasizes realtime speech but does not expose a concise full language matrix on the overview page   | Function calling, cloned/system voices; 50 audio turns and 300 seconds of retained audio context                                                                                      | Best focused Qwen option for voice-only assistants and customer service                                                             |
| **Doubao-Seed-RealtimeVoice**                                            | Officially described as native end-to-end speech-to-speech                                              | Natural interruption; official product page quotes roughly 700 ms bare-model and about 1 second overall latency | Chinese-first, with dialect/accent capabilities highlighted                                                        | Product page mentions realtime web access; detailed public protocol documentation is less transparent than Qwen/xAI                                                                   | Strong Chinese voice quality and latency candidate; requires a hands-on API access and tool-use validation POC                      |
| **Baidu audio-realtime family**                                          | End-to-end Cross-Attention speech-language model over WebSocket; Lite/Pro and near-/far-field variants  | Server VAD with response interruption enabled                                                                   | Official API page is Chinese-first and does not clearly publish a broad multilingual matrix                        | Product claims about 1-second response; event schema closely resembles Realtime-style sessions                                                                                        | Worth testing for Chinese emotional companion and near-/far-field scenarios; narrower disclosed ecosystem than Qwen                 |
| **Hume EVI 4-mini / EVI 3**                                              | Real-time speech-language service over WebSocket, with prosody analysis and streamed audio output       | Explicit interruption sensitivity and rapid yield on user interjection                                          | EVI 4-mini supports 11 listed languages, but not Chinese; EVI 3 is English-only                                    | EVI 4-mini requires a supplemental LLM; maximum session duration is 30 minutes                                                                                                        | Excellent for emotion/prosody-centric experiences, but not a pure single-model GPT Realtime substitute and not suitable for Chinese |

## Managed real-time voice-agent stacks

These are valid solutions when the requirement is the product experience rather than native audio reasoning:

| Platform                       | What it provides                                                                                                            | Important distinction                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Microsoft Azure Voice Live** | WebSocket/WebRTC, barge-in, semantic VAD, noise suppression, custom speech/voices, tools, avatars, and multiple chat models | Microsoft describes the general path as speech recognition + generative AI + TTS in one interface; non-realtime chat models are cascaded, while `azure-realtime` is a dedicated realtime option |
| **ElevenAgents**               | One real-time WebSocket, 5k+ voices, configurable LLMs, turn-taking, interruption, telephony, tools and observability       | Its documented architecture coordinates ASR + chosen LLM + TTS + proprietary turn-taking; it is not one native speech foundation model                                                          |
| **Deepgram Voice Agent API**   | Single WebSocket for listening, thinking, speaking, function calls, telephony, regional endpoints, and latency reports      | Explicitly an STT + LLM + TTS pipeline; useful when ASR latency and operational simplicity matter most                                                                                          |
| **Cartesia Line**              | Hosted agents, WebSocket audio, telephony, interruption controls, and low-latency Sonic speech                              | Sonic is primarily a TTS model; Line is the orchestration product                                                                                                                               |

## Open-weight and self-hosted options

| Model                     | Realtime behavior                                                                                                     | Languages / deployment                                            | Caveat                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MiniCPM-o 4.5**         | Explicit full-duplex continuous audio/video input while concurrently generating text and speech; official WebRTC demo | Chinese and English speech; 9B model; Mac/PC and GPU paths        | Best current Chinese-capable edge/self-hosted candidate, but production hardening and quality evaluation remain the integrator's responsibility   |
| **NVIDIA PersonaPlex 7B** | Explicit real-time full-duplex speech-to-speech, based on Moshi, with voice conditioning and role prompts             | English-centric; self-hosted server and browser client            | Open weights under NVIDIA's model license, not a managed SLA-backed API                                                                           |
| **Kyutai Moshi**          | Two audio streams model user and assistant concurrently; roughly 200 ms practical latency reported on an L4 GPU       | English-centric; PyTorch, Rust/Candle, and Apple MLX stacks       | Research-oriented conversational quality and domain intelligence trail frontier cloud systems                                                     |
| **Qwen3-Omni**            | Native multimodal model with streaming text/speech output and official real-time interaction demos                    | 19 speech-input and 10 speech-output languages, including Chinese | Self-hosted continuous streaming input/server maturity must be validated for the exact inference stack; streaming output alone is not full duplex |
| **Step-Audio 2 mini**     | End-to-end speech conversation with audio understanding, generation, tools, and RAG                                   | Chinese-focused open-weight option                                | Relevant for experimentation, but the public project does not make as strong a full-duplex claim as MiniCPM-o or PersonaPlex                      |

## Recommended evaluation order

### Chinese mainland product

1. **Qwen-Audio 3.0 Realtime Plus**: best combination of public protocol detail, semantic turn detection, function calling, and Chinese support.
2. **Doubao-Seed-RealtimeVoice**: likely strongest candidate for natural Chinese delivery and latency; validate API availability, tool calls, transcripts, and commercial terms.
3. **Baidu audio-realtime Pro**: validate emotional expression, far-field performance, and domain intelligence.
4. **MiniCPM-o 4.5**: add when privacy, edge deployment, or offline operation materially matters.

### Global product

1. **Gemini 3.1 Flash Live** for multilingual voice + vision + tool use.
2. **xAI Grok Speech-to-Speech** for OpenAI Realtime migration, tools, SIP, and long sessions.
3. **Nova 2 Sonic** when AWS governance and Bedrock integration dominate, provided its language list is sufficient.
4. **Hume EVI** when emotional attunement matters more than broad language coverage or single-model purity.

## Implementation validation (2026-08-28)

The protocol POC is complete for the mainland-China shortlist. Cognia uses one
normalized controller and transport while keeping provider framing inside thin
adapters:

- Qwen uses the Beijing workspace endpoint, DashScope Bearer key from the host
  keyring, PCM16 at 16 kHz uplink / 24 kHz downlink, and documented function
  calls. The default is `qwen-audio-3.0-realtime-plus` with `longanqian`.
- Doubao uses the fixed realtime-dialogue endpoint, Resource ID and App Key;
  only App ID is deployment metadata and only Access Key is stored as a secret.
  Its V1 gzip binary frames carry lifecycle, server VAD, ASR, chat, interruption,
  and 24 kHz PCM output. Tools are omitted because this protocol does not expose
  function calling.
- Baidu uses its documented realtime WebSocket with API-key Bearer auth, the
  `audio-realtime-near` default, PCM16 audio, realtime-style events, and tools.

All three are native-only, limited to the `cn` region, use the shared
proxy-aware WebSocket, and remain unavailable in static web builds. Their public
environment flags are opt-out kill switches rather than implementation gates.

## POC acceptance tests

Vendor latency numbers are not directly comparable: some measure model first-token latency, others end-to-end speech onset under ideal networking. Run the same recordings and network conditions across candidates and measure:

- end-of-user-speech to first audible output (P50/P95);
- interruption detection to audio stop, plus whether conversation context is correctly truncated;
- false end-of-turn and false barge-in rates for pauses, backchannels, noise, and echo;
- Chinese names, numbers, addresses, dialects, code-switching, and domain vocabulary;
- tool-call latency and whether the model can speak naturally while a slow tool runs;
- transcript accuracy versus what the model actually heard/said;
- reconnection and session-resumption behavior;
- cost per 10-minute two-way conversation, including both input and output audio and any separate LLM/TTS charges.

## Primary sources

- Google: [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api), [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [models](https://ai.google.dev/gemini-api/docs/models)
- AWS: [Nova 2 Sonic speech-to-speech](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-conversational-speech.html), [language support](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-language-support.html)
- xAI: [Speech-to-Speech model page and guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)
- Alibaba Cloud: [Omni-modal model matrix](https://www.alibabacloud.com/help/en/model-studio/omni/), [Qwen-Audio realtime guide](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-realtime-user-guides), [Qwen-Omni realtime SDK](https://www.alibabacloud.com/help/en/model-studio/omni-realtime-python-sdk)
- Volcano Engine: [Doubao speech product](https://www.volcengine.com/products/Audio-editing-and-sound-processing), [RealtimeVoice product](https://www.volcengine.com/product/realtime-voice-model)
- Baidu: [end-to-end speech-language model API](https://cloud.baidu.com/doc/SPEECH/s/nmcytnwei)
- Hume: [EVI overview](https://dev.hume.ai/docs/speech-to-speech-evi/overview), [interruption configuration](https://dev.hume.ai/docs/speech-to-speech-evi/configuration/interruption)
- Microsoft: [Azure Voice Live guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to), [Voice Live SDK overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-sdk)
- ElevenLabs: [ElevenAgents overview](https://elevenlabs.io/docs/eleven-agents/overview), [WebSocket guide](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets)
- Deepgram: [Voice Agent overview](https://developers.deepgram.com/docs/voice-agent), [architecture description](https://developers.deepgram.com/docs/build-a-voice-agent)
- Cartesia: [Line integration overview](https://docs.cartesia.ai/line/integrations/overview), [Sonic WebSocket TTS](https://docs.cartesia.ai/api-reference/tts/websocket)
- Open-weight projects: [MiniCPM-o](https://github.com/OpenBMB/MiniCPM-o), [PersonaPlex](https://github.com/NVIDIA/personaplex), [Moshi](https://github.com/kyutai-labs/moshi), [Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni), [Step-Audio 2](https://github.com/stepfun-ai/Step-Audio2)
