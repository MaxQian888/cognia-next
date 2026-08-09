# ACP and Claude Code Model Selection Research

Date: 2026-08-03

## Conclusion

The message `Model selection is unavailable on claude-code — the agent protocol has no equivalent.` is accurate only for the current CLI/TUI integration path, and is not an accurate description of the current ACP v1 protocol.

ACP historically had no stable, generic model-selection operation. Older adapters either exposed no model control or used the experimental `session/set_model` method. ACP v1 now standardizes model selection through session config options: an agent returns a `configOptions` entry with `category: "model"` from `session/new`, and the client changes it with `session/set_config_option`. The current official Claude Agent ACP adapter implements this route.

In Cognia, the desktop external-agent path already handles the modern route. The CLI/TUI path is the part that reports the limitation: it only enables an external model picker for the native Codex app-server `model/list` method, and it does not yet read or mutate ACP `configOptions`.

## Primary sources

- ACP v1 Session Config Options: <https://agentclientprotocol.com/protocol/v1/session-config-options.md>
- ACP v1 protocol index: <https://agentclientprotocol.com/llms.txt>
- Official Claude Agent ACP adapter: <https://github.com/agentclientprotocol/claude-agent-acp>
- Current Claude adapter implementation: <https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts>
- Historical report about the experimental Claude ACP `session/set_model` support: <https://github.com/xenodium/agent-shell/issues/127>

## What ACP supports today

The current ACP v1 config-option flow is session-scoped and agent-owned:

1. The client creates a session with `session/new`.
2. The agent may return `configOptions` in the session response.
3. A model selector is represented as a select option whose semantic category is `model`.
4. The client sends `session/set_config_option` with `sessionId`, `configId`, and the selected `value`.
5. The agent returns the complete updated config state, because changing a model can change dependent options such as reasoning effort or speed.
6. The agent may also push a `session/update` notification with `sessionUpdate: "config_option_update"` when the state changes internally, for example after a model fallback.

ACP intentionally does not require a universal model catalog or a universal model identifier. The agent decides which models are available, how they are labelled, and which dependent settings exist. This is different from a host-owned provider catalog and from Codex app-server's separate `model/list` method.

The ACP specification's category is a semantic UI hint, not a promise that every agent has a model option. A client must inspect the config options returned by the active session and treat model selection as available only when the agent actually exposes a selectable `category: "model"` option.

## What the current official Claude adapter does

The current `agentclientprotocol/claude-agent-acp` source keeps model state internally but exposes model selection through ACP `SessionConfigOption`. Its config-option handler resolves a selected model and applies it to the Claude Agent SDK query. Its config-option builder creates a `model` option from the adapter's model information, and the ACP request handler wires `session/set_config_option` to that implementation.

The source also contains comments describing the migration from the old model-state path to the `SessionConfigOption` path. Therefore, “Claude Code has no model selection” is version- and adapter-dependent. It was a reasonable statement for older Claude ACP versions, but it is not the current state of the official adapter as of this research date.

The historical path matters because the repository still contains both models of the API:

- Legacy `session/set_model`: explicit in Cognia's ACP client and older ecosystem assumptions.
- Current `session/set_config_option`: the ACP v1 route used by the current official Claude adapter.

## Cognia implementation trace

### CLI/TUI path: why the exact error appears

`cli/src/tui/runtime/backend-capabilities.ts` defines `MODEL_LISTING_PRESETS` as only `codex-app-server`. Its comment explicitly says the `codex` ACP shim has no model-list call and that ACP has no model-list call. For every other external preset, `modelPicker` is marked unsupported with the reason `the agent protocol has no equivalent`.

When the TUI opens the model picker, `cli/src/tui/components/App.tsx` checks this capability and returns the generated unsupported-feature message before making any request. The resulting wording is therefore a static capability-gate message, not an ACP handshake result from Claude Code.

The model-loading helper in `cli/src/tui/runtime/backend-models.ts` confirms the same design: it asks the external manager for a Codex app-server adapter and calls its `listModels()` method. If the adapter is not a Codex app-server adapter, it returns an empty list. It does not call `getConfigOptions()` or send `session/set_config_option`.

The live external session class does have a `setModel()` method, but that method delegates to `manager.setSessionModel()`, which sends legacy `session/set_model`. It is not the modern ACP config-option flow. The CLI capability gate prevents the TUI from reaching this path for Claude Code in the first place.

### Desktop external-agent path: modern ACP support already exists

`lib/ai/agent/external/acp-client.ts` stores `configOptions` returned from `session/new`, exposes `getConfigOptions()`, validates values, sends `session/set_config_option`, and replaces the stored options with the complete response from the agent. It also handles `config_option_update` notifications.

`components/agent/external-agent/config-options.tsx` renders ACP config options and recognizes `model` as a model selector. `components/agent/external-agent/session-panel.tsx` mounts that UI for live external sessions. Thus the desktop path can already show a Claude model selector when the active Claude ACP adapter returns a model option.

The same ACP client retains a separate `setSessionModel()` implementation that sends `session/set_model`. That legacy method should not be confused with the current canonical path; it is a compatibility layer for agents that still expose the older model state.

## Why the two statements seem contradictory

There are three different capabilities being conflated:

| Capability                       | Owner                   | Wire shape                                                | Cognia status                                                                |
| -------------------------------- | ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Enumerate a host-owned catalog   | Codex app-server        | `model/list`                                              | Supported only for `codex-app-server` in CLI/TUI                             |
| Select a model in an ACP session | ACP agent               | `session/new.configOptions` + `session/set_config_option` | Supported in desktop ACP adapter; not wired into CLI/TUI picker              |
| Legacy direct model mutation     | Some older ACP adapters | `session/set_model`                                       | Retained in Cognia compatibility code; not a reliable generic ACP capability |

The protocol itself does not promise that every ACP agent supports a model selector. It does provide a standard way for an agent that does support one to advertise and change it. Claude Code's ability therefore depends on the Claude ACP adapter version and on whether that adapter returns a model config option for the session.

## Recommended architectural correction

The CLI/TUI should stop using `model/list` as the definition of external ACP model selection. A correct implementation would:

1. Read the active ACP session's `configOptions` after `session/new` or `session/load`.
2. Select options with `category === "model"` and a selectable option type.
3. Render the agent-provided labels and values.
4. Send `session/set_config_option` when the user chooses a model.
5. Replace the local option state with the complete response and process subsequent `config_option_update` notifications.
6. Report model selection as unavailable only when the active session has no model config option, rather than because the preset is not Codex.

The capability should be negotiated from the active session state, not inferred solely from the preset name. This also handles agents that expose modes, reasoning levels, model fallback, or dependent options without requiring Cognia to maintain an agent-specific model catalogue.
