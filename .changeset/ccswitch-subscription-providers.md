---
"cognia-next": minor
---

Subscription: fix Claude quota refresh + add cc-switch relay providers

- **Fix "Claude 额度刷新无效"**: the unified-limits path now refreshes an expired
  OAuth access token before/after the free `/api/oauth/usage` GET (previously the
  401 was swallowed at every layer and the refresh button silently no-op'd once
  the ~8h token expired). `subscription_authed_get` also now routes through the
  configured proxy, so the quota GET works for CN / firewalled setups the same
  way token refresh already did.
- **+20 provider presets (ported from cc-switch v3.17)**: DeepSeek, Zhipu GLM
  (CN + Z.ai), Kimi, Kimi For Coding, MiniMax (CN + global), StepFun, 火山方舟
  Agent Plan, LongCat, Baidu Qianfan, Bailian, Xiaomi MiMo, OpenRouter,
  SiliconFlow, Novita, Qiniu, ModelScope, Shengsuanyun, PackyCode — added as
  Anthropic-wire (`anthropic-native`) catalog entries. They surface in
  Settings → Providers (base URL + API key) and as one-click Anthropic
  subscription preset templates.
- **Model lists on every relay**: each new relay preset now ships a selectable
  model list (its native coding model — e.g. Kimi `kimi-k2.7-code`, DeepSeek
  `deepseek-v4-pro`, GLM `glm-5.1`, StepFun `step-3.5-flash-2603`, 火山
  `ark-code-latest`, MiniMax `MiniMax-M2.7` — merged with cognia's existing
  models for that brand; pure Claude relays list opus/sonnet/haiku), fixing the
  empty model dropdown / missing default (notably Kimi). The existing Moonshot
  (Kimi) provider's stale `moonshot-v1-*` list is refreshed to the current
  `kimi-k2.7-code` (legacy ids kept).
- **Quota / balance sync**: coding-plan usage descriptors (GLM 5h/weekly, Kimi,
  MiniMax) and the DeepSeek / OpenRouter / SiliconFlow / Kimi credit-balance
  adapters now resolve their endpoint from the base-URL origin, so a relay preset
  (`…/api/anthropic`, `…/step_plan`) reports the right window/balance instead of
  a malformed URL.
- **Volcengine (火山方舟) usage windows**: a SigV4-signed Rust command
  (`subscription_volcengine_usage`) queries the Agent/Coding Plan OpenAPI
  (`GetAFPUsage` → `GetCodingPlanUsage`) and a hand-written limits source renders
  the 5h / weekly / monthly windows. The AccessKey ID / Secret live in the preset
  under an `x-cognia-volc-*` namespace that is stripped from chat requests, so the
  account-wide key never rides on the wire.
