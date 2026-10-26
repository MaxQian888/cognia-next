# OpenCode custom subagent support in Cognia

> Historical research snapshot taken before implementation. The model-overwrite
> limitation below is addressed by [the implementation report](2026-10-21-opencode-per-agent-models.md).

Research date: 2026-10-21 (Asia/Shanghai).

Scope: inspect the current working tree, verify configuration behavior with existing tests, and compare it with official OpenCode documentation and source. This report adds no runtime changes. It is a new report because the question spans configuration, UI, gateway projection, and migration rather than one existing subsystem document.

## Findings

Cognia supports choosing a shared native subagent model for task-owned OpenCode V1, ACP, and V2 runs through its Cognia model gateway. It also accepts custom named agent definitions through inline OpenCode configuration. It does **not** preserve independently selected models for each custom agent on that gateway route: its projector rewrites them to a common child model or the primary model.

| Cognia runtime                        | Gateway model API       | Child model slot   | Helper model slot           | Projected configuration         |
| ------------------------------------- | ----------------------- | ------------------ | --------------------------- | ------------------------------- |
| OpenCode V1, locally spawned server   | OpenAI Chat Completions | `subagent.default` | `aux.small` → `small_model` | `agent`, `provider`, `prompt`   |
| OpenCode ACP                          | OpenAI Chat Completions | `subagent.default` | `aux.small` → `small_model` | Same V1 shape                   |
| OpenCode V2, task-owned local service | OpenAI Chat Completions | `subagent.default` | None                        | `agents`, `providers`, `system` |

Evidence: [runtime admission and ingress](../../lib/ai/agent/external/config/gateway-task.ts), [slot declarations](../../lib/ai/agent/external/config/model-slots.ts), and [projection tests](../../lib/ai/agent/external/config/gateway-task.test.ts).

“OpenAI Chat Completions” describes the agent-to-model gateway API. V1's HTTP/SSE and ACP's stdio JSON-RPC are separate Cognia-to-agent transports. The ACP row above describes Cognia's current V1 projection contract, not a claim that every future executable implementing ACP must use V1 configuration.

## What can be customized today

### Shared child model through the UI

In the external-agent editor, select a Cognia primary model, then use the **子任务模型 → 默认子代理模型** field. V1 and ACP additionally show **小型辅助模型**. Without a primary Cognia binding these fields cannot be edited; this model-role mechanism belongs to the gateway route.

The fields are mounted in [agent-editor-dialog.tsx](../../components/settings/agent/agent-editor-dialog.tsx), implemented by [role-model-fields.tsx](../../components/agent/external-agent/role-model-fields.tsx), and translated in the split [Chinese message source](../../i18n/messages/zh-CN/externalAgent.json). Subagent templates have a separate model-role layer through [template-cognia-model-fields.tsx](../../components/settings/subagents/panels/template-cognia-model-fields.tsx).

Models must use the primary model's provider and account. Cross-provider/account bindings and unsupported slots are rejected by [model-plan.ts](../../lib/ai/agent/external/config/model-plan.ts). OpenCode slots currently declare no per-slot reasoning-effort choices. The [manager](../../lib/ai/agent/external/manager.ts) compiles the plan and passes it to `buildGatewayTaskConfig`; these declarations are wired into task execution.

### Custom native definitions through inline configuration

The process-environment editor can carry `OPENCODE_CONFIG_CONTENT`. On the gateway route, `openCodeCustomization` accepts a strict subset of OpenCode configuration. For example:

V1 / Cognia's ACP projection:

```json
{
  "agent": {
    "reviewer": {
      "description": "Review code for correctness",
      "mode": "subagent",
      "prompt": "Review the assigned code and explain actionable defects.",
      "permission": { "edit": "deny" }
    }
  }
}
```

Native V2 projection:

```json
{
  "agents": {
    "reviewer": {
      "description": "Review code for correctness",
      "mode": "subagent",
      "system": "Review the assigned code and explain actionable defects.",
      "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }]
    }
  }
}
```

These illustrate configuration accepted by the projector; they are not live execution or permission-enforcement acceptance results. Choose the child model with `subagent.default`. Supplying a different `model` inside either example will not preserve it on the Cognia gateway route.

The parser allows common fields including description, mode, hidden, color, steps and default agent; V1 also permits prompt, temperature, top_p, tools and permission, while V2 uses system, disabled and permissions. It rejects unlisted configuration rather than passing arbitrary native options through. Gateway customization also rejects source `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` paths and rebuilds model/provider routing itself. See [the customization schemas and projector](../../lib/ai/agent/external/config/gateway-task.ts).

### Importing OpenCode agent Markdown

Cognia can import OpenCode Markdown agents into its own subagent templates or characters. The [registered importer](../../lib/claude/subagent-importers/index.ts) reads names, prompts, enabled tool names and model hints; the [OpenCode adapter](../../lib/claude/subagent-importers/opencode.ts) warns that native permission rules are not imported. [Conversion](../../lib/claude/subagent-importers/convert.ts) creates Cognia templates, and [apply](../../lib/claude/subagent-importers/apply.ts) writes Cognia storage.

This is migration into Cognia's own template system. It does not establish that editing a Cognia template writes a corresponding native OpenCode agent file or registers it inside an OpenCode task.

## Model behavior and gaps

`openCodeCustomization` currently applies these rules before launch:

| Entry                                                      | Effective model                                      |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| Inline agent explicitly declaring `mode: "subagent"`       | Selected child model, otherwise primary              |
| Inline agent declaring `primary`, `all`, or omitting mode  | Primary                                              |
| Built-in `general` and `explore`, when a child slot is set | Child model, merged into existing inline definitions |
| Inline command, including one with `subtask: true`         | Primary                                              |
| V1 `small_model`                                           | Selected helper model, otherwise primary             |
| V2 `small_model`                                           | Not emitted                                          |

Consequences:

1. **One default child model is implemented; per-agent model preservation is missing on the gateway route.** A reviewer and an explorer cannot retain distinct explicit model choices through the current inline projector.
2. **The default-model hint overstates preservation.** The UI says the child default applies when neither the definition nor the spawning call specifies a model. In fact, the OpenCode projector replaces an inline definition's explicit model. The hint and actual projection should be reconciled if this is implemented further.
3. **`all` and omitted modes need separate consideration.** Native OpenCode can use these as subagents, but Cognia projects their model to the primary. The current tests explicitly assert that behavior; passing tests therefore establish the implementation, not compatibility with every native expectation.
4. **Local files are not a reliable gateway customization channel.** The task sets `OPENCODE_DISABLE_PROJECT_CONFIG=true` and uses a task-owned home and `OPENCODE_CONFIG_DIR`. Do not assume agents in the user's ordinary global or project directories automatically enter these tasks. See [CLI task isolation](../../cli/src/runtime/external/gateway-task.ts) and [native task isolation](../../crates/cognia-sandboxd/src/gateway_task.rs).
5. **Attached servers are outside this model-role projection.** The gateway requires task-owned configuration. An attached V1 endpoint, including a loopback URL, receives no gateway slots. V2 permits task-owned launch with a process command; a purely attached endpoint does not. Native server-side configuration must be managed where that server runs. See `cogniaGatewayRuntime`, `cogniaGatewaySupport`, and [V2 launch behavior](../../packages/agent-opencode/src/v2-client.ts).

The ordinary native lane delegates configuration to OpenCode and the selected state home. OpenCode itself supports individual custom-agent models; the gateway rewriting described above is a Cognia constraint.

## Upstream comparison

[OpenCode agents documentation](https://opencode.ai/docs/agents/) supports custom agent definitions, per-agent models and subagent mode. [Its configuration documentation](https://opencode.ai/docs/config/#models) defines `small_model` for lightweight tasks such as titles; it is separate from subagent selection. [ACP documentation](https://opencode.ai/docs/acp/#support) includes agents and permissions among supported features.

The public documentation still illustrates V1-style JSON. For V2, the upstream source inspected at commit `3a1f9a934fef659d4cfd6bd3964da6340cf0c3e9` gives more precise evidence:

- [Root schema](https://github.com/anomalyco/opencode/blob/3a1f9a934fef659d4cfd6bd3964da6340cf0c3e9/packages/schema/src/config.ts#L26) uses `agents` and `providers`, with no root `small_model`.
- [Agent schema](https://github.com/anomalyco/opencode/blob/3a1f9a934fef659d4cfd6bd3964da6340cf0c3e9/packages/schema/src/config/agent.ts#L11) uses `system` and `permissions`.
- [Model selection](https://github.com/anomalyco/opencode/blob/3a1f9a934fef659d4cfd6bd3964da6340cf0c3e9/packages/schema/src/config/model.ts#L13) accepts a string or `{ providerID, model, variant? }`. Cognia's string projection is valid in this respect.
- [Subagent execution](https://github.com/anomalyco/opencode/blob/3a1f9a934fef659d4cfd6bd3964da6340cf0c3e9/packages/core/src/tool/plugin/subagent.ts#L168) chooses a new child's model with `override ?? agent.model ?? parent.model`; only `primary` agents are barred from subagent use.

The installed `@opencode/client` is 2.0.23; its `ConfigEntry` declaration independently accepts both model forms and has no root `small_model`. The local `opencode --version` reports `opencode v2.0.5`. Source/schema agreement is not proof of a successful run with that executable.

## Verification and limits

Executed through the repository's `pnpm test` entry point:

```text
model-slots.test.ts
model-plan.test.ts
gateway-task.test.ts
role-model-fields.test.tsx
Test Suites: 4 passed, 4 total
Tests:       179 passed, 179 total
Snapshots:   1 passed, 1 total
```

A supplementary run included the OpenCode importer, importer registry, and agent editor:

```text
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 103 passed, 104 total
```

Both importer suites passed. The editor failure was `refuses an invalid sandbox host before saving`: Testing Library could not find a textbox named `Allowed hosts` at `agent-editor-dialog.test.tsx:249`. This report changed no application or test code, and the failure was not repaired as part of research. React act-environment warnings also appeared in that run.

No real model request, native subagent delegation, ACP handshake, browser/Tauri acceptance, or deployed verification was performed. No coverage, full typecheck, application lint or production build was run for this documentation-only investigation. The report itself was checked with the repository's Prettier.

If the intended requirement is independent models for each native OpenCode subagent, the remaining work is to define per-agent bindings, retain their validated explicit models during projection, handle `all`/omitted modes, and verify real child-session model selection across V1, ACP and V2. That implementation is not part of this research.
