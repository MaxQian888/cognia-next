# Kimi Code subscription plugin

[中文说明](./README.zh-CN.md)

A complete, explicitly installable example of Cognia's `subscription-provider` capability.
It contributes Kimi Code to the existing subscription account forms and model selectors. There is
no provider-specific panel, credential reader, or network client in this plugin. It declares both
OpenAI Chat Completions and Anthropic Messages entries, rich fallback metadata, and live model listing.

## Requirements

- Cognia desktop with the `subscription-provider` capability (the registry implementation in this
  repository). Older builds without that capability cannot use the example; the app's `0.1.0`
  version alone does not establish support.
- A Kimi Code membership that provides an API key, obtained in the
  [Kimi Code console](https://www.kimi.com/code/console).
- Repository dependencies installed with `pnpm install` to build the example.

This uses the **Kimi Code subscription API**, not the Moonshot pay-as-you-go API. Moonshot platform
keys and endpoints are separate. Browser and mobile activation are blocked because this account
flow requires the desktop credential vault.

## Build and install

From the repository root:

```sh
pnpm exec node plugins/kimi-subscription/build.mjs
```

Output: `plugins/kimi-subscription/dist/cognia-kimi-subscription-0.2.0.zip`.
The ZIP contains `plugin.json`, the compiled `dist/index.js`, and both READMEs. It has no runtime
dependency on the repository, SDK package, or Node.js. The build uses the repository's esbuild and
JSZip dependencies; do not install a second copy inside this directory.

1. Open Cognia desktop's Plugins panel and choose the local `.wasm` / `.zip` install action.
2. Select the generated ZIP, review the manifest, install it, and enable the plugin if necessary.
3. Open Settings → Subscriptions → Account Center and add **Kimi Code** (OpenAI Chat) or
   **Kimi Code (Anthropic)** (Messages). Pick the protocol you intend to use.
4. Enter an account label and the key from the Kimi Code console in the shared API-key form.
5. Use the model refresh action in the form to fetch the account-specific list; inspect model
   information before saving if needed. A failed or unsupported listing does not erase the declared
   models or prevent manual account setup.
6. Activate the saved account, then select your Kimi provider and `kimi-for-coding` in the chat model picker.
   Use the subscription for coding tasks in accordance with Kimi's terms.

The provider is also available through the other registry-driven subscription add menus and preset
account flows. The existing OpenAI identifier stays `cognia-kimi-subscription:kimi-code`; the Anthropic entry is
`cognia-kimi-subscription:kimi-code-anthropic`. They have separate account namespaces. Install an
updated ZIP over the same plugin ID to retain existing accounts.

## Models and membership

Verified against the [official model documentation](https://www.kimi.com/code/docs/en/kimi-code/models.html)
on **2026-09-11**:

| Model ID                    | Membership requirement | Selection guidance                                        |
| --------------------------- | ---------------------- | --------------------------------------------------------- |
| `kimi-for-coding`           | All Kimi Code members  | Default; the service manages the model behind this alias. |
| `k3-256k`                   | Moderato or higher     | K3 with a fixed 256K context.                             |
| `k3`                        | Moderato or higher     | Context limit depends on membership.                      |
| `kimi-for-coding-highspeed` | Allegretto or higher   | Higher-speed model with greater quota consumption.        |

The catalogue lists documented models, not your account's entitlements. Start with `kimi-for-coding`.
The alias behind `kimi-for-coding` can change without a client update. The current docs describe
K2.8 Preview, and disabling thinking routes K3/K2.8 to K2.8 with thinking off. This
example does not add provider-specific reasoning controls or claim that every client supports all
model-specific options.

The OpenAI Chat Completions base URL is `https://api.kimi.com/coding/v1`. The host appends the request
path and supplies the credential. The Anthropic root is `https://api.kimi.com/coding/`; the host
normalizes it to `/coding/v1` exactly once before requesting `/messages`. OpenAI explicitly declares
`apiFlavor: "chat"`; Responses is a separate host-supported flavor and is not advertised for Kimi.
The plugin never overrides headers or impersonates an official
Kimi client. See the [membership guide](https://www.kimi.com/en/help/kimi-code/membership-guide).

## Model list and information APIs

Both entries opt into `GET https://api.kimi.com/coding/v1/models`. The host applies the selected
protocol’s authentication, parses model names, context limits and capability fields, and preserves
unknown fields from the declaration. Live, account-specific values take precedence. Model details
are derived from this list (`retrieve: false`); the example does not invent a `/models/{id}` endpoint.
The host also supports a standard detail endpoint when another plugin explicitly declares one.

Fallback metadata includes vision, reasoning, streaming and context lengths. Kimi documents upstream
video support for several models, but Cognia currently accepts images/documents rather than raw video
through these adapters, so this example declares `supportsVideo: false`. Live API metadata describes
the upstream model; it does not add a new attachment type to Cognia.
K3 uses a conservative 256K fallback because its 1M entitlement depends on the plan; refresh can
replace it with the account-specific limit. Maximum input and output tokens are stored separately from the total context. Kimi’s documented
CLI model response does not provide a maximum output limit; this example leaves it unknown until
the server supplies one. The host recognizes explicit input/output limits and carries them into
model selection, agent requests, routing and compaction. Unknown prices are also omitted.
This applies to Cognia-dispatched requests and subagents. Managed external tasks also receive model
metadata through runtime-specific configuration and gateway enforcement, as described below.
SDK-native controls that the runtime does not expose remain outside Cognia's configuration surface.
Provider settings → Refresh models uses the same subscription API and updates model information.
A listed model still may have usage restrictions; discovery does not verify an inference request.

## Use the subscription in an external agent

1. Install and configure this plugin as above.
2. In either Settings → Agents or the chat agent manager, add/edit a supported local Codex,
   OpenCode, Pi, Claude ACP, or Qwen Code ACP agent and enable **Use Cognia models**.
3. Select this plugin's provider, `kimi-for-coding`, and the subscription account. Start a new task.

The agent retains its own tools and conversation loop. Cognia supplies a task-specific configuration
and temporary gateway credential; the Kimi key stays in Cognia. Codex's Responses requests are
translated by the gateway to the plugin's declared upstream protocol. Do not change Kimi's
`apiFlavor` to `responses` to use Codex.

Context/input/output limits are supplied when known, and the gateway enforces its model and token
constraints. Each task retains its selected model, subscription account, and Cognia owner across
resume. Changing model/account requires a new task. Stop revokes the lease; deleting the conversation
removes retained task state. Filesystem/network isolation follows the selected sandbox. Attached
remote agents and unsupported runtimes are refused rather than given an unreachable loopback route.

Real-client checks cover Codex tool calls through the Rust gateway and Pi sandboxed tool calls and
resume with local fixtures. They do not establish Kimi membership entitlements or authenticated
Kimi inference compatibility for every agent/model combination.

## Bind a Team member or SDK subagent

For an external Team member, select its runtime and enable **Use Cognia models** in the member
editor. The binding is saved on that member, and each dispatch gets an isolated gateway task.
Steering and stop use the task's own session; a resumed task keeps its original model/account.

A separate plugin with the `agent:dispatch` permission can use the typed SDK contract:

```ts
import {
  defineSubagent,
  type ExternalAgentCogniaModelBinding,
  type PluginContext,
} from "@cognia/plugin-sdk"

export async function reviewWithKimi(ctx: PluginContext, prompt: string, accountId: string) {
  const cogniaModel: ExternalAgentCogniaModelBinding = {
    providerId: "cognia-kimi-subscription:kimi-code",
    modelId: "kimi-for-coding",
    accountId,
  }
  const reviewer = defineSubagent({
    id: "kimi-reviewer",
    name: "Kimi reviewer",
    description: "Reviews code through Cognia's Kimi subscription.",
    prompt: "Review the requested code and report actionable findings.",
    externalPresetId: "codex-app-server",
    cogniaModel,
  })
  return ctx.agent.dispatchSubagent(reviewer, prompt)
}
```

Use a saved Cognia subscription account ID, never an API key. Omit `accountId` to resolve the
current account when a new task starts; that resolved account is frozen for resume. To override
the definition for one call, pass `{ cogniaModel: anotherBinding }` as the third argument.
`{ cogniaModel: null }` explicitly selects the agent's native model configuration. A native
`model` string alone does not choose a Cognia provider/account. The subscription example itself
does not request agent dispatch permission or automatically start agents.

## Account lifecycle and troubleshooting

- Keys go through Cognia's existing credential vault. They do not belong in `plugin.json`, plugin
  settings, source files, or the ZIP; no secret-read permission is requested.
- Disabling or uninstalling the plugin removes its available provider and models. Saved accounts
  remain in the host vault for explicit removal or reuse after reinstalling the same plugin ID.
- Usage opens the official console. This example declares no automatic balance/quota endpoint.
- A `401` can mean an ineligible model tier as well as an invalid key. Try `kimi-for-coding`, check
  your membership and key in the console, and ensure this is a Kimi Code key, not a Moonshot key.
- For quota or rate-limit errors, check the console and the
  [official error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html).
- If Kimi Code is absent, check plugin activation and desktop compatibility. If it appears in the
  model picker but cannot send, ensure a saved account is active and its model is allowed by your plan.

## Adapt this example

Copy this directory excluding `dist/`. Change the plugin ID/name and each
`subscriptionProviders` declaration in `plugin.json`: local provider ID, protocol, base URL, model
IDs or rich model objects, model API support, and official links. Keep only the protocols the
service supports; set `apiFlavor: "responses"` for an OpenAI Responses service. The first model is the default. Keep the entry module unchanged: it imports
the JSON, and the host handles registration, all account panels, presets, credentials, and cleanup.
Update the READMEs and test expectations, then rebuild. Changing an existing plugin/provider ID
creates a different account namespace; preserve IDs when updating an installed provider.

Use this approach for standard OpenAI Chat Completions or Anthropic Messages services with API keys.
OAuth, custom signatures, and automatic usage adapters require additional host capabilities.

## Verification

From the repository root, without coverage collection:

```sh
pnpm exec node --test plugins/kimi-subscription/build.test.mjs
pnpm exec jest --runInBand --coverage=false --roots plugins/kimi-subscription --runTestsByPath plugins/kimi-subscription/src/index.test.ts
```

The tests validate the real installer schema, host bridge registration/removal, model selection,
manifest parity, archive contents, and execution of the compiled entry. They do not make authenticated
Kimi requests or establish whether your membership permits a particular model.
