# MiniMax M Plan Subscription

[中文说明](./README.zh-CN.md)

An explicitly installable desktop plugin. The separate directory is intentional: MiniMax can be installed, updated, or disabled independently. It contributes declarative subscription accounts, fallback models, and host-executed usage requests. It has no network client, credential reader, runtime dependency bundle, or provider-specific account panel.

## Build and install

Run from the repository root with dependencies installed:

```sh
pnpm exec node plugins/minimax-subscription/build.mjs
pnpm exec jest --runInBand --coverage=false --runTestsByPath plugins/minimax-subscription/src/index.test.ts plugins/minimax-subscription/build.test.mjs
```

Install `plugins/minimax-subscription/dist/cognia-minimax-subscription-0.1.0.zip` using Cognia desktop's Plugins local ZIP installer, then enable it. This requires a Cognia version supporting subscription billing metadata and declarative usage requests; the app's 0.1.0 version alone does not prove support. Browser and mobile activation are blocked because accounts require the desktop credential vault. The PNG icon is rendered from Cognia's existing Lobe vendor asset.

## Accounts and AI Providers

1. Open Settings → Subscriptions → Account Center → Add account.
2. Select the China or International entry and the OpenAI Chat / Anthropic Messages protocol that matches your account. Regions and protocols have separate account namespaces.
3. Paste the **Subscription Key** from M Plan details. Do not use a standard pay-as-you-go API Key.
4. Save and explicitly activate the account. In AI Providers, the plugin's subscription entry links back to account management and exposes connection testing and models.
5. Choose its subscription model in chat or a supported external agent using Cognia models.

Each entry declares `billingMode: "subscription"`, a vendor brand and related-provider IDs. Related entries are navigation links only: keys, active accounts and enable states are not copied into standard API providers. Missing, expired or exhausted subscription credentials must not trigger an automatic pay-as-you-go fallback. Disabling the plugin removes its available provider entries/models; saved host-vault accounts remain for explicit deletion or reinstalling the same plugin/provider IDs.

M Plan replaces the marketed Token Plan; existing legacy subscribers retain their vendor-managed benefits. Subscription Keys use included M Plan allowance and eligible credit packs. Extra credit packs may cover overflow under MiniMax rules; this is distinct from charging the API account balance with a standard API Key. Inference URLs alone cannot establish the billing source because both key types use the same API hosts.

## Endpoints and models

| Entry ID                        | Protocol  | Base URL                           |
| ------------------------------- | --------- | ---------------------------------- |
| `minimax-m-plan`                | openai    | `https://api.minimax.cn/v1`        |
| `minimax-m-plan-anthropic`      | anthropic | `https://api.minimax.cn/anthropic` |
| `minimax-m-plan-intl`           | openai    | `https://api.minimax.io/v1`        |
| `minimax-m-plan-anthropic-intl` | anthropic | `https://api.minimax.io/anthropic` |

The declared default is MiniMax-M3.1-Flash-Preview, with a 524288-token client context window and 128000-token maximum output, as documented in the official third-party tool configuration. Text and image input, tools, reasoning and streaming are declared; raw video/audio support is not advertised through Cognia chat adapters.

These are documented fallback model IDs and capabilities, not verified account entitlements. No model-list/detail API is declared because the subscription documentation does not establish those endpoints. The plugin never invents a model discovery URL or overrides headers to impersonate another client. Vendor plan restrictions and supported-use rules still apply.

## Usage and errors

The host sends GET /v1/token_plan/remains with Bearer authentication to www.minimax.cn (China) or www.minimax.io (International), explicitly separate from the inference host. The general model_remains entry supplies authoritative remaining percentages for 5-hour and weekly windows; meters invert them to used percentages. Reset timestamps use milliseconds. Ambiguous legacy *_usage_count fields are not interpreted. Missing fields remain unknown; the official console is available for verification.

No API key is embedded in the manifest, source, plugin settings, archive, or returned usage snapshot. Host-owned requests use the selected account. A 401/403 can indicate the wrong key, region, plan entitlement or expired subscription. Quota and connection errors remain visible; verify the account in the official console. There were no authenticated live requests in this change.

## Sources

Verified 2026-10-18 against official documentation and vendor-maintained code:

- [International tool configuration](https://platform.minimax.io/docs/m-plan/other-tools)
- [China tool configuration](https://platform.minimax.cn/docs/m-plan/other-tools)
- [International FAQ: keys, billing and quota endpoint](https://platform.minimax.io/docs/m-plan/faq)
- [China FAQ](https://platform.minimax.cn/docs/m-plan/faq)
- [Official CLI quota schema](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
- [Official CLI legacy count ambiguity](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)

Tests validate installer schema, manifest/module parity, billing isolation metadata, protocol/region endpoints, quota extraction and deterministic self-contained ZIP execution. They do not establish authenticated vendor acceptance.

Subscription plugin inference and quota requests always use the declared endpoints; relay presets and URL overrides saved on older accounts are ignored without modifying the stored accounts.
