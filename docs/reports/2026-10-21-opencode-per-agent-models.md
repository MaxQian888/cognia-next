# Individual OpenCode subagent models

Date: 2026-10-21

Cognia now preserves explicit models for individual native OpenCode subagents on
its model gateway route. V1 and ACP use `agent`; V2 uses `agents`. An absent child
model inherits `subagent.default`, or the primary model when no child default is
configured. Explicit `subagent`, `all`, and implicit custom child definitions are
supported. Built-in primary agents retain their primary role.

## Configure

Use the existing external agent editor's process environment field. Set
`OPENCODE_CONFIG_CONTENT` to an inline JSON object. For V1 and ACP:

```json
{
  "agent": {
    "reviewer": { "mode": "subagent", "model": "cognia/review" },
    "researcher": { "mode": "subagent", "model": "cognia/search" },
    "fallback": { "mode": "subagent" }
  }
}
```

For V2, replace `agent` with `agents`. V2 also retains explicit variant selection:
`"model": "cognia/review#high"` or
`"model": { "providerID": "cognia", "model": "review", "variant": "high" }`.

Open the editor through `/settings?section=agents`. For V2, enable Cognia models
and leave the service endpoint empty to configure a task-owned local service.
Its process environment and sandbox fields then become available. Saving or
renaming this configuration retains its inline native agent definitions.

The model IDs must exist on the selected primary provider/account. The `cognia`
prefix is the task-local gateway alias; that provider's actual ID is also accepted
and normalized. Incompatible provider/account selections and malformed inline
configuration are refused during editor/host validation and before minting a
gateway ticket. Explicit models are included in its allowlist and the model-plan
fingerprint, including variants.

A slash command naming a child agent inherits that agent's projected model when
the command omits its own model. An explicit model on that command is preserved
and admitted too. This prevents command projection from overriding the child
with the primary model.

`aux.small` continues to configure V1/ACP `small_model` for auxiliary calls. It is
independent of the child default. V2 does not project `small_model`.

## Runtime integration

The local V1 adapter is registered again and the V1 local-server preset is
executable. Its CLI must be a compatible V1 release. ACP retains the V1 config
shape; V2 uses its own service adapter and configuration shape. Explicit remote
attached-server behavior remains outside the task-owned gateway route.

The implementation extends the existing parser, model compiler, ticket path,
editor and host validation. A new standalone smoke script is necessary to run
all three native adapters against one deterministic loopback provider fixture:
`scripts/smoke/opencode-subagent-models.ts`. It isolates HOME/XDG/config, uses
synthetic credentials/prompts, and cleans up the launched services.

## Verification

- The original regression failed for all three projectors before the fix.
- Focused admission/projection/editor tests passed; child-command precedence
  additionally passed for V1, ACP and V2. The final projector suite passed all
  **151 tests**, including string/object whitespace validation. Five new malformed
  reference cases failed before the final validation fix and passed afterward.
- Actual native V1 **1.19.3**, ACP **1.19.3** and V2 **2.0.23** processes each
  delegated to `review`, `search` and `default` as configured. The loopback
  OpenAI Chat Completions fixture observed all three distinct model IDs.
  Latest rerun: `.cache/opencode-subagent-models/2026-10-21T13-21-49.456Z/results.json`.
- Root lint, targeted lint, formatting, capability generation/audit, co-located
  test gate and i18n build/check/lint/sort checks passed. The OpenCode package
  runtime build passed with `tsup --no-dts`.
- Subsequent typecheck was skipped as requested. No coverage command was run.

Native probes establish config acceptance and model selection using real CLI
processes and a local protocol fixture. They do not establish paid-provider or
real Tauri acceptance. The workstation's default OpenCode V2 **2.0.5** returned
404 for the current service API; the probe explicitly used **2.0.23**.

The follow-up affected-suite run passed **833 tests across 12 suites**, with no
failures (`.cache/opencode-followup-acceptance.log`). The two earlier failures
are resolved: sandbox selection uses the current picker interaction, and the
unsupported-version fixture uses `999` instead of the now-supported version `2`.
OpenCode V1, ACP and V2 now have explicit create/patch version checks and sandbox
validation cases. Negative provider/account assertions remain intact.

The follow-up also reproduced and fixed a V2 editor defect: saving dropped
`process.env`, and task-owned launches did not expose process configuration.
The new regression failed before the fix. V2 now retains the inline subagent
configuration, validates its environment/sandbox settings, and recognizes the
default `opencode` command for state isolation.

During the browser retest, shared package hooks used by OpenCode settings
introduced a Next.js compilation error: `"use client"` appeared after imports.
Only the directive placement was corrected in
`packages/plugin-contract/src/hooks/use-element-width.ts` and
`use-isomorphic-layout-effect.ts`; hook behavior was retained. Their **11 tests
across two suites pass** (`.cache/opencode-startup-hook-tests.log`). The browser
then loaded `/settings?section=agents` without the build overlay and completed an
OpenCode ACP configuration create/reload/edit check. Its two explicit child
models and the unspecified fallback survived the round trip:
`.cache/opencode-followup-browser.json`,
`.cache/opencode-followup-browser-status.json`, and
`.cache/opencode-followup-browser.png`.

This browser has no paired process host, so launching a stdio agent there is
unavailable. Native workspace/service startup and delegation were verified by
the separate real CLI probes above. The V2 gateway editor save path is covered
by RTL; no paid-provider or Tauri UI acceptance is claimed.

The earlier static-export gate reported Node imports in
`lib/browser/extension-engine.ts` and `lib/plugin/core/builtin-artifact-fixture.ts`.
A full app production build was not completed. These unrelated export failures
remain outside the user's OpenCode-specific follow-up scope, and the global gate
was not rerun in this follow-up. The earlier browser startup blocker is
superseded by the successful browser check above.

See [the evidence ledger](../evidence/2026-10-21-opencode-per-agent-models.md)
for the verification boundaries and remaining obligations.
