# Zhipu / Z.ai Coding Plan

[中文说明](./README.zh-CN.md)

An explicitly installable desktop plugin. The separate directory is intentional: Zhipu / Z.ai can be installed, updated, or disabled independently. It contributes declarative subscription accounts, fallback models, and host-executed usage requests. It has no network client, credential reader, runtime dependency bundle, or provider-specific account panel.

## Build and install

Run from the repository root with dependencies installed:

```sh
pnpm exec node plugins/zhipu-subscription/build.mjs
pnpm exec jest --runInBand --coverage=false --runTestsByPath plugins/zhipu-subscription/src/index.test.ts plugins/zhipu-subscription/build.test.mjs
```

Install `plugins/zhipu-subscription/dist/cognia-zhipu-subscription-0.1.0.zip` using Cognia desktop's Plugins local ZIP installer, then enable it. This requires a Cognia version supporting subscription billing metadata and declarative usage requests; the app's 0.1.0 version alone does not prove support. Browser and mobile activation are blocked because accounts require the desktop credential vault. The PNG icon is rendered from Cognia's existing Lobe vendor asset.

## Accounts and AI Providers

1. Open Settings → Subscriptions → Account Center → Add account.
2. Select the China or International entry and the OpenAI Chat / Anthropic Messages protocol that matches your account. Regions and protocols have separate account namespaces.
3. Paste the API key from the matching BigModel or Z.ai account that has an active GLM Coding Plan. The selected Coding Plan endpoint determines subscription usage.
4. Save and explicitly activate the account. In AI Providers, the plugin's subscription entry links back to account management and exposes connection testing and models.
5. Choose its subscription model in chat or a supported external agent using Cognia models.

Each entry declares `billingMode: "subscription"`, a vendor brand and related-provider IDs. Related entries are navigation links only: keys, active accounts and enable states are not copied into standard API providers. Missing, expired or exhausted subscription credentials must not trigger an automatic pay-as-you-go fallback. Disabling the plugin removes its available provider entries/models; saved host-vault accounts remain for explicit deletion or reinstalling the same plugin/provider IDs.

BigModel China and Z.ai International are separate account systems. Standard API uses /api/paas/v4, while these OpenAI entries use the dedicated /api/coding/paas/v4 endpoint. Anthropic uses /api/anthropic. Do not replace a subscription endpoint with the standard API endpoint to work around a quota failure. Use the standard provider separately when deliberately choosing pay-as-you-go.

## Endpoints and models

| Entry ID                    | Protocol  | Base URL                                      |
| --------------------------- | --------- | --------------------------------------------- |
| `glm-coding`                | openai    | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `glm-coding-anthropic`      | anthropic | `https://open.bigmodel.cn/api/anthropic`      |
| `glm-coding-intl`           | openai    | `https://api.z.ai/api/coding/paas/v4`         |
| `glm-coding-anthropic-intl` | anthropic | `https://api.z.ai/api/anthropic`              |

The declared models are glm-5.3 (text) and glm-5.3-flash (text/image), with 1M context and 128K output. FlashX is deliberately excluded: official documentation says it is not yet part of the Coding Plan. Both support tools, streaming and reasoning. Raw video/audio support is not advertised through Cognia chat adapters.

These are documented fallback model IDs and capabilities, not verified account entitlements. No model-list/detail API is declared because the subscription documentation does not establish those endpoints. The plugin never invents a model discovery URL or overrides headers to impersonate another client. Vendor plan restrictions and supported-use rules still apply.

## Usage and errors

The host sends GET /api/monitor/usage/quota/limit at the inference host origin. The official vendor usage plugin uses the raw API key in Authorization without a Bearer prefix. Existing host extraction selects data.limits entries with unit 3 (5-hour) and 6 (weekly), reads percentage and unix-second nextResetTime, and leaves absent windows unknown. The official console remains available when older/newer response shapes differ.

No API key is embedded in the manifest, source, plugin settings, archive, or returned usage snapshot. Host-owned requests use the selected account. A 401/403 can indicate the wrong key, region, plan entitlement or expired subscription. Quota and connection errors remain visible; verify the account in the official console. There were no authenticated live requests in this change.

## Sources

Verified 2026-10-18 against official documentation and vendor-maintained code:

- [Z.ai Coding Plan overview](https://docs.z.ai/devpack/overview)
- [BigModel Coding Plan FAQ and endpoints](https://docs.bigmodel.cn/cn/coding-plan/faq)
- [Z.ai FAQ and endpoints](https://docs.z.ai/devpack/faq)
- [GLM-5.3 model reference](https://docs.z.ai/guides/llm/glm-5.3)
- [GLM-5.3-Flash model reference](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [Official usage-query plugin](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)

Tests validate installer schema, manifest/module parity, billing isolation metadata, protocol/region endpoints, quota extraction and deterministic self-contained ZIP execution. They do not establish authenticated vendor acceptance.

Subscription plugin inference and quota requests always use the declared endpoints; relay presets and URL overrides saved on older accounts are ignored without modifying the stored accounts.
