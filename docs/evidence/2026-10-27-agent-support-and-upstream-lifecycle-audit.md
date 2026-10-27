# Evidence ledger: agent support and upstream lifecycle audit

- Status: verifying
- Lane: deep
- Created: 2026-10-27
- Updated: 2026-10-27
- Related: ADR-0090, ADR-0216, ADR-0217; working-tree external-agent catalogs

## Original request

> 校对一下cognia对下面的agent的支持情况，注意还要检查对应的agent是否活着，死了的就不要了

The requested names are Claude Code, Codex, Grok, Cursor, GitHub Copilot,
Muse, DeepSeek Harness, ZCode, OpenCode, MiMo Code, Amp, OpenClaude,
Antigravity, Pi, oh-my-pi, Hermes Agent, Devin, Goose, Auggie, Autohand Code,
Charm, Cline, CodeBuddy, Codebuff, Freebuff, Command Code, Continue, Droid,
Kilocode, Kimi, Kiro, Mistral Vibe, Qwen Code, Rovo Dev, and “+ any CLI agent”.

### Authorized implementation follow-up

> 把这些还活着但没接入的 agent 的支持补齐，oh-my-pi 也接入应用，修复这次发现的 OpenCode 测试和 runtime gate 问题，并做完整验证，别只加预设。注意符合现在的架构，，代码结构合理，有问题你可以先和我确认

The user selected managed terminal sessions for agents without a confirmed
stable machine interface: launch, status, interaction, stop and cleanup, with
explicit capability limits. Agents with usable ACP/SDK/machine interfaces use
the structured chat path. The earlier matrix below is the audit baseline;
implementation acceptance is tracked in the following table.

| Requirement | Flow and ownership                                                                                              | Acceptance and verification                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-01      | Settings catalog → configure native protocol/account/workspace → existing external-agent host → chat execution. | Every new structured product has protocol wiring, inspected launch identity, host policy, capability/mode truth, instructions, streaming/failure/cancel/cleanup and negotiated session/MCP handling; regression and isolated real-process checks. |
| REQ-02      | Terminal-only catalog → explicit workspace → existing PTY host and dock.                                        | Reachable launch, deduplicated live session, native interaction, accurate exit/status, reopen, stop and removal; no fake structured chat capability.                                                                                              |
| REQ-03      | Oh My Pi → application entry → supported current protocol.                                                      | A real app-selected execution route, not merely an unregistered package or metadata row; host permission/outbound boundaries and lifecycle verified.                                                                                              |
| REQ-04      | OpenCode compatibility picker and runtime governance checker.                                                   | Preserve executable V1/V2 compatibility; actual checks pass and reject missing/malformed preset declarations.                                                                                                                                     |
| REQ-05      | Complete integration review and validation.                                                                     | Relevant unit/integration/package/native checks, type/lint/static-export/i18n/build gates, browser/native flow and source/diff review; report genuine blockers with exact evidence.                                                               |

Implementation sequence: establish exact current machine contracts and authority
limits; implement behind existing host ports; complete per-product registration,
policy and app paths; run focused red-to-green tests and isolated actual CLIs;
run broader gates and actual UI/native acceptance; reconcile each requirement.

No missing agent executable was found on the current PATH at follow-up start.
The filesystem had 8.1 GiB free. Task-local installs and builds must preserve
the shared workspace and existing installations; missing credentials or device
resources remain explicit acceptance prerequisites, not reasons to relabel
fixture traffic as authenticated acceptance.

## Problem frame

The remaining audit sections through the baseline review record preserve the
initial read-only snapshot. They do not describe the post-implementation state;
the implementation results and outstanding acceptance work follow them.

Audit the current working tree and current primary upstream sources. Separate
product lifecycle, built-in structured execution, package-only implementation,
manual terminal use, and runtime acceptance. An installable CLI, model-provider
entry, MCP configuration, transcript importer, or live repository alone does
not establish an executable Cognia agent integration. The deliverable is an
audit and a concrete remediation list.

The audit found **16 registered products, 1 package-only product, and 17 products
without built-in execution presets**, out of 34 requested names. No current
product in the list has sufficient primary evidence to remove it as dead.
Discontinued predecessors and moved repositories must be handled by exact
identity, as described below. No runtime source was changed by this audit.

This new dated ledger is necessary because previous evidence files cover
individual integrations or different dates; none covers this exact 34-product
inventory and its lifecycle comparison.

## Knowledge

| ID  | Statement                                                                                                                                                   | State    | Basis                                                                                                                                                                 | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Audit all 34 named products and exclude discontinued implementations from the resulting support recommendations.                                            | Agreed   | User request, 2026-10-27.                                                                                                                                             | -          |
| C1  | Preserve concurrent changes and distinguish source registration from tested runtime behavior.                                                               | Verified | Current task instructions and dirty working tree, 2026-10-27.                                                                                                         | -          |
| O1  | Exactly 16 requested products map to current built-in execution presets and runtime catalog entries.                                                        | Verified | TypeScript AST extraction, runtime JSON comparison and source tracing; source-snapshot.json, 2026-10-27.                                                              | -          |
| O2  | oh-my-pi has a private integration package but no app dependency, protocol factory, built-in preset or runtime registration.                                | Verified | packages/agent-omp/package.json and src/manifest.ts, root package.json, manager.ts and runtime JSON, 2026-10-27.                                                      | -          |
| O3  | All 34 current product identities have current primary-source existence/distribution evidence; no current-product retirement was established.               | Verified | Two upstream research groups; primary sources in the matrix below, 2026-10-27. Existence is not an inference-service health check.                                    | -          |
| O4  | The old Python Kimi CLI and old Go OpenCode predecessor are discontinued; current Kimi Code and Crush remain active.                                        | Verified | Exact official archive/migration notices linked below, 2026-10-27.                                                                                                    | -          |
| O5  | The six selected Jest suites report 179 passed and 2 failed tests.                                                                                          | Observed | catalog-tests.log; Node v26.12.1, pnpm 11.18.0, 2026-10-27.                                                                                                           | -          |
| O6  | The runtime gate reads the preset union from its former owning file and reports false missing-preset errors.                                                | Verified | Standard gate fails; diagnostic reads 0 IDs at old path, 27 at owning path, and runChecks returns no errors with the owning source. gate-diagnostic.json, 2026-10-27. | -          |
| O7  | A generic CLI can use an available PTY manually, but structured execution needs a registered protocol, permitted command/environment, and a supported host. | Verified | Terminal session.rs, manager protocol registration, CLI validateCommand and Rust SpawnPolicy, 2026-10-27.                                                             | -          |
| O8  | ACP Registry discovery exists in the lifecycle service but has no application caller or browsing surface.                                                   | Verified | discoverRegistryRuntimes definition and call-site search; lifecycle/service.ts and registry-discovery.ts, 2026-10-27.                                                 | -          |

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                             |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | 34 product identities across multiple upstream owners.                                                                  |
| technical    | medium | ACP, native RPC, app-server, SDK, headless and terminal-only surfaces differ.                                           |
| coupling     | medium | Presets, runtime catalog, security policy, host factories and UI exposure must agree.                                   |
| requirement  | low    | Audit and lifecycle filtering; no general integration implementation requested.                                         |
| verification | medium | Primary lifecycle evidence and source checks are available; account-specific runtime health is outside this audit.      |
| risk         | medium | Incorrect lifecycle filtering could remove an active successor; overstated support could promise nonexistent execution. |

## Risks

| ID  | Risk (impact)                                                                                     | Severity | Source                                                     | Claim                                                        | Refuted by                                                           |
| --- | ------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| R1  | A retired artifact or repository move is mistaken for a dead current product.                     | medium   | Kimi, Crush, Kilo, Goose and Codebuff upstream identities. | Filter by exact product and artifact, with primary evidence. | A current official retirement notice for a retained product.         |
| R2  | Catalog entries, dormant packages or manual CLI use are advertised as equivalent runtime support. | medium   | Current factory and catalog wiring.                        | Matrix describes the supported surface and its limits.       | A missing factory/preset in a claimed built-in route.                |
| R3  | Failing checks or historical smokes are presented as current full acceptance.                     | medium   | Focused test failures and older evidence reports.          | Report current checks and historical evidence separately.    | Claiming authenticated or cross-platform acceptance from this audit. |

## Verification obligations

| ID  | Risk   | Method                                                                                                           | Independence | Evidence                                                                                                                 | Coverage                                                                               | Status |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------ |
| V1  | R2     | Parse actual preset object, cross-check runtime rows, trace factory/security/registry paths.                     | tool         | source-snapshot.json: requested=34, registered=16, packageOnly=1, notRegistered=17.                                      | Working-tree static wiring; not inference.                                             | passed |
| V2  | R1     | Check canonical official docs, repositories, archive notices and distribution metadata for every requested name. | subagent     | upstream-a.md and upstream-b.md, with primary links reproduced below; 17 names per group.                                | Product existence and maintenance signals; not account entitlement or endpoint health. | passed |
| V3  | R2, R3 | Run six existing catalog, preset, protocol-picker and registry Jest suites through pnpm test.                    | tool         | 5 suites passed, 1 failed; 179 tests passed, 2 failed. Failures concern legacy OpenCode picker expectations.             | Local unit/contract checks; no coverage collected.                                     | failed |
| V4  | R2, R3 | Run pnpm audit:external-agent-runtimes and diagnose failure without changing source.                             | tool         | Generated catalog is current; normal gate exits 1. Injecting the relocated owning preset-type source yields zero errors. | Catalog governance and parser diagnosis; normal entry point remains failing.           | failed |
| V5  | R3     | Review report completeness, task-only diff, formatting and source freshness.                                     | tool         | Final review record below.                                                                                               | Audit artifact only; existing unrelated changes preserved.                             | passed |

## Decisions

| ID  | Date       | Decision                                                                                                             | Action   | Based on           | Reversal trigger                                                       |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ---------------------------------------------------------------------- |
| D1  | 2026-10-27 | Deliver a source-backed audit; do not add unsupported presets from logos or generic CLI claims.                      | diagnose | G1, C1, O1, O2, O7 | User requests implementation of specific additional integrations.      |
| D2  | 2026-10-27 | Keep all current product identities; exclude only exact discontinued predecessors from recommendations.              | ship     | O3, O4             | Authoritative evidence establishes a current product has been retired. |
| D3  | 2026-10-27 | Carry current test/gate inconsistencies as findings rather than rewriting concurrent runtime work during this audit. | diagnose | G1, C1, O5, O6     | A follow-up authorizes the identified repairs.                         |

## Complete support matrix

“Registered” means a built-in structured execution route exists in the checked
working tree. It is not a claim that every upstream feature or current release
has passed authenticated acceptance. “Not built in” still permits manual
terminal use when the executable, credentials and terminal host are available.
ACP compatibility elsewhere does not automatically add a Cognia preset,
security policy, credential environment, writable-state policy or certification.

| #   | Requested name / canonical product | Upstream lifecycle evidence                                                                                                                                                                                                                                   | Cognia current structured execution                                                                           | Disposition / integration detail                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude Code                        | Active: [Anthropic repository](https://github.com/anthropics/claude-code).                                                                                                                                                                                    | Registered: `claude-code`, ACP via `claude-agent-acp`. Cognia also has a separate built-in Claude SDK engine. | Keep. Identify the [ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) separately from the vendor CLI.                                                                                                                         |
| 2   | Codex                              | Active: [OpenAI repository](https://github.com/openai/codex).                                                                                                                                                                                                 | Registered: native `codex app-server`; explicit ACP route also exists.                                        | Keep. Native app-server and ACP are distinct surfaces; cloud/IDE documentation is not local execution.                                                                                                                                            |
| 3   | Grok → Grok Build                  | Active: [xAI product](https://x.ai/build), [vendor source](https://github.com/xai-org/grok-build).                                                                                                                                                            | Registered: `grok agent --no-leader stdio`, ACP.                                                              | Keep official Grok Build identity; do not substitute an unrelated community Grok CLI.                                                                                                                                                             |
| 4   | Cursor → Cursor Agent CLI          | Active: [official CLI docs](https://cursor.com/docs/cli/overview).                                                                                                                                                                                            | Registered: `cursor-agent acp`.                                                                               | Keep. [Official changelog](https://cursor.com/changelog/cli-jan-08-2026) retains `cursor-agent` as an alias of `agent`; current installer still creates both. IDE/background-agent surfaces are separate.                                         |
| 5   | GitHub Copilot → Copilot CLI       | Active: [official quickstart](https://docs.github.com/en/copilot/get-started/cli-quickstart).                                                                                                                                                                 | Registered: `copilot --acp`.                                                                                  | Keep current Copilot CLI; [ACP is public preview](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).                                                                                                                 |
| 6   | Muse → Meta Muse Code              | Active: [Meta docs](https://dev.meta.ai/docs/muse-code), [2026-08-05 launch](https://developer.meta.com/ai/resources/blog/build-with-muse-code/).                                                                                                             | Not built in.                                                                                                 | Keep as candidate. Native `muse serve`/`muse schema` and `@muse-code/sdk`; vendor ACP not established here. Muse Spark model support is separate.                                                                                                 |
| 7   | DeepSeek Harness                   | Active developer preview: [official repository](https://github.com/deepseek-ai/deepseek-harness).                                                                                                                                                             | Registered: managed runtime with SDK read-only/workspace-write and interactive ACP profiles.                  | Keep. Managed launch preparation is required; empty static process commands are not missing registrations. Current upstream also documents `npx @deepseek-ai/dsh web`; pinned source runtime support does not imply latest-package certification. |
| 8   | ZCode                              | Active: [Z.ai repository](https://github.com/zai-org/ZCode), [agent docs](https://zcode.z.ai/en/docs/agents).                                                                                                                                                 | Not built in.                                                                                                 | Keep as candidate. `zcode` TUI/web product exists; hosting other agents does not prove ZCode itself exposes ACP.                                                                                                                                  |
| 9   | OpenCode, current project          | Active: [current repository](https://github.com/anomalyco/opencode), [ACP docs](https://opencode.ai/docs/acp/).                                                                                                                                               | Registered: `opencode acp`, V2 service HTTP/SSE, and legacy V1 HTTP/SSE routes.                               | Keep current OpenCode. V1/V2 picker expectations disagree in current tests; do not conflate with archived Go OpenCode.                                                                                                                            |
| 10  | MiMo Code                          | Active: [Xiaomi repository](https://github.com/XiaomiMiMo/MiMo-Code), [vendor docs](https://mimo.xiaomi.com/mimocode/start).                                                                                                                                  | Not built in.                                                                                                 | Keep as candidate. CLI `mimo`, documented `mimo serve`/`attach`; interoperability with Cognia's existing protocols is not established. Model-provider support is separate.                                                                        |
| 11  | Amp                                | Active: [official CLI docs](https://ampcode.com/docs/cli).                                                                                                                                                                                                    | Not built in.                                                                                                 | Keep as candidate. Execute Mode and Streaming JSON are documented; no native ACP established here.                                                                                                                                                |
| 12  | OpenClaude                         | Active independent project: [Twigpine/openclaude](https://github.com/Twigpine/openclaude).                                                                                                                                                                    | Not built in.                                                                                                 | Keep as candidate. Current package `@twigpine/openclaude`, CLI `openclaude`; not Anthropic Claude Code or an automatic reuse of its adapter.                                                                                                      |
| 13  | Antigravity                        | Active: [Google CLI docs](https://antigravity.google/docs/getting-started?tab=cli), [official ACP integration](https://antigravity.google/docs/ide/extensions/zed/).                                                                                          | Registered: separate `agy_acp_server.par` runtime.                                                            | Keep. `agy` terminal login and the separately distributed ACP server are different surfaces.                                                                                                                                                      |
| 14  | Pi                                 | Active: [earendil-works/pi](https://github.com/earendil-works/pi).                                                                                                                                                                                            | Registered: `pi --mode rpc`, native JSONL RPC.                                                                | Keep current npm scope `@earendil-works/pi-coding-agent`; Pi is distinct from oh-my-pi.                                                                                                                                                           |
| 15  | oh-my-pi                           | Active: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), [releases](https://github.com/can1357/oh-my-pi/releases).                                                                                                                                    | Package only: `@cognia/agent-omp`; no app factory, preset, dependency or runtime entry.                       | Keep as candidate, explicitly not product-ready. Package declares native `omp-rpc`; later upstream also advertises ACP. Host preparation/guard and registration remain required.                                                                  |
| 16  | Hermes Agent                       | Active: [NousResearch repository](https://github.com/NousResearch/hermes-agent), [CLI reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md).                                                              | Not built in.                                                                                                 | Keep as candidate. `hermes`/`hermes chat`, one-shot and stream JSON exist; do not use legacy single-query runner identity as the preferred product.                                                                                               |
| 17  | Devin → Devin CLI                  | Active: [official CLI](https://devin.ai/cli), [vendor launch](https://cognition.com/blog/devin-for-terminal).                                                                                                                                                 | Registered: `devin acp`, with vendor-specific per-session composition.                                        | Keep CLI route; [ACP registry entry](https://zed.dev/acp/agent/devin). Cloud Devin availability is a separate surface.                                                                                                                            |
| 18  | Goose                              | Active: [current aaif-goose/goose repository](https://github.com/aaif-goose/goose), [ACP docs](https://goose-docs.ai/docs/gdk/acp/).                                                                                                                          | Registered: `goose acp --with-builtin developer`, approval mode.                                              | Keep; follow repository move from `block/goose`. Catalog certification remains narrower than current upstream releases.                                                                                                                           |
| 19  | Auggie                             | Active: [Augment CLI reference](https://docs.augmentcode.com/cli/reference).                                                                                                                                                                                  | Not built in.                                                                                                 | Keep; native [`auggie --acp`](https://docs.augmentcode.com/cli/acp/agent) is a candidate for the shared ACP adapter after host integration.                                                                                                       |
| 20  | Autohand Code                      | Active: [official source](https://github.com/autohandai/code-cli).                                                                                                                                                                                            | Not built in.                                                                                                 | Keep; native [`autohand --acp`](https://github.com/autohandai/code-cli/blob/main/docs/guides/ACP.md), npm `autohand-cli`.                                                                                                                         |
| 21  | Charm → Crush by Charm             | Active successor: [charmbracelet/crush](https://github.com/charmbracelet/crush).                                                                                                                                                                              | Not built in.                                                                                                 | Normalize to Crush (Charm). [`crush run`](https://github.com/charmbracelet/crush/blob/main/internal/cmd/run.go) exists; native ACP not established. Exclude archived Go OpenCode predecessor.                                                     |
| 22  | Cline                              | Active: [official repository](https://github.com/cline/cline), [ACP source docs](https://github.com/cline/cline/blob/main/docs/usage/acp.mdx).                                                                                                                | Registered: `cline --acp --auto-approve false`.                                                               | Keep actual CLI runtime. Current preset explicitly records version-specific image/MCP limitations and pending authenticated acceptance.                                                                                                           |
| 23  | CodeBuddy                          | Active: [Tencent CLI docs](https://www.codebuddy.ai/docs/cli/README).                                                                                                                                                                                         | Not built in.                                                                                                 | Keep; current npm `@tencent-ai/codebuddy-code`, `codebuddy --acp` per [official command docs](https://www.codebuddy.ai/docs/cli/slash-commands).                                                                                                  |
| 24  | Codebuff                           | Active distribution: [official quickstart](https://www.codebuff.com/docs/help/quick-start), [npm metadata](https://registry.npmjs.org/codebuff).                                                                                                              | Not built in.                                                                                                 | Keep; [`@codebuff/sdk`](https://www.codebuff.com/docs/advanced/sdk) is documented. Repository redirect to Freebuff is not a retirement notice.                                                                                                    |
| 25  | Freebuff                           | Active: [official CLI page](https://freebuff.com/cli), [current repository](https://github.com/CodebuffAI/freebuff), [npm metadata](https://registry.npmjs.org/freebuff).                                                                                     | Not built in.                                                                                                 | Keep terminal candidate. Latest-release headless/ACP contract not established; older official articles describe interactive-only use.                                                                                                             |
| 26  | Command Code → CommandCode.ai      | Active: [official docs](https://commandcode.ai/docs), [npm metadata](https://registry.npmjs.org/command-code).                                                                                                                                                | Not built in.                                                                                                 | Keep; native [`cmd acp`](https://commandcode.ai/docs/acp), npm `command-code`.                                                                                                                                                                    |
| 27  | Continue → Continue CLI            | Active: [official repository](https://github.com/continuedev/continue), [CLI docs](https://docs.continue.dev/cli/quickstart).                                                                                                                                 | Not built in.                                                                                                 | Keep; `cn -p ... --format json`/`cn serve` are documented, native ACP not established. IDE integration does not substitute for a CLI adapter.                                                                                                     |
| 28  | Droid → Factory Droid              | Active: [Factory integration docs](https://docs.factory.com/ide-integrations), [official ACP Registry manifest](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json).                                                          | Registered: `droid exec --output-format acp-daemon`.                                                          | Keep. Current Registry uses exactly this command; manual `--output-format acp` is a separate documented surface, not evidence Cognia's command is broken.                                                                                         |
| 29  | Kilocode → Kilo Code / Kilo CLI    | Active: [current Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode), [CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli).                                                                                                                       | Not built in.                                                                                                 | Keep; `@kilocode/cli`, `kilo acp`. Legacy `Kilo-Org/kilo` was moved/archived.                                                                                                                                                                     |
| 30  | Kimi → current Kimi Code           | Active successor: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).                                                                                                                                                                            | Registered: current npm `@moonshot-ai/kimi-code`, `kimi acp`.                                                 | Keep current route. Exclude old archived Python `kimi-cli` and its PyPI aliases. Current preset reviews 2.2.0; latest npm observed 2.3.3 is not newly certified here.                                                                             |
| 31  | Kiro → Kiro CLI                    | Active, V3 transition: [official rollout](https://kiro.dev/blog/cli-3/), [ACP migration guide](https://kiro.dev/docs/cli/v3/acp-migration/).                                                                                                                  | Registered: `kiro-cli acp` (documented V2 route).                                                             | Keep. V3 explicitly uses `--agent-engine=v3`; evaluate separately. Existing ACP client already prefers model config options, but this is not complete V3 acceptance. No V2 shutdown date established.                                             |
| 32  | Mistral Vibe                       | Active: [Mistral repository](https://github.com/mistralai/mistral-vibe), [official installer docs](https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli).                                                                                | Not built in.                                                                                                 | Keep; native executable [`vibe-acp`](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md), distinct from `vibe`.                                                                                                                |
| 33  | Qwen Code                          | Active: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code).                                                                                                                                                                                              | Registered: `qwen --acp`.                                                                                     | Keep. [Official architecture](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) describes native ACP; model-only provider support is separate.                                                                                 |
| 34  | Rovo Dev                           | Available during transition: [Atlassian command reference](https://support.atlassian.com/rovo/docs/rovo-dev-cli-commands/), [official staff transition announcement](https://community.atlassian.com/forums/discussion/3315222/introducing-rovo-cli-beta/p1). | Not built in.                                                                                                 | Keep transitional product candidate. Existing `acli rovodev run`/`serve`; successor `rovo` has different command/config identity. No current shutdown established.                                                                                |

### Lifecycle filtering: what to exclude

- **Old Python Kimi CLI:** [authoritative archive/migration notice](https://github.com/MoonshotAI/kimi-cli)
  explicitly says maintenance, fixes and security updates ended and existing
  installations will stop working. Keep the new npm Kimi Code product; Cognia
  already targets it. PyPI `kimi-code` is an old alias, not the replacement npm
  package `@moonshot-ai/kimi-code`.
- **Old Go OpenCode:** [opencode-ai/opencode](https://github.com/opencode-ai/opencode)
  explicitly says development moved to Crush. Exclude that implementation from
  new integration work. Keep modern `anomalyco/opencode` and Crush separately.
- **Moved Kilo repository:** [Kilo-Org/kilo](https://github.com/Kilo-Org/kilo)
  is archived and points to `Kilo-Org/kilocode`. Follow the current repository;
  do not delete Kilo Code as a product.
- **Repository moves alone are not death:** Goose moved to `aaif-goose/goose`;
  Codebuff's repository redirects to Freebuff while Codebuff's CLI/SDK
  distribution and official docs remain present. Rovo Dev explicitly remains
  available during its transition.

### “+ any CLI agent” needs a narrower promise

The supported general statement is: **an installed CLI agent can be used
manually in an available Cognia terminal; structured agent integration depends
on its protocol and host integration.** Browser-only environments need an
available terminal/process host. No arbitrary-agent terminal acceptance was
performed by this audit.

Structured execution currently has concrete factories for ACP, Codex
app-server, OpenCode V1/V2, Pi RPC, DSH SDK, Aider CLI and A2A. Legacy generic
`custom`/`http`/`websocket` protocol values are not universal adapters.
An ACP agent without a built-in preset may be technically configurable, but
its executable, provider environment, state roots and sandbox still need
appropriate host policy. Rust supports explicit operator command additions;
the audited CLI validator has a separate default allowlist. Neither is an
unconditional promise that every CLI agent can run through the structured API.

ACP Registry discovery is implemented but deliberately dormant: it does not
make every registry agent visible, installable, or certified in the application.
The Oh My Pi package is similarly an implementation artifact rather than a
runtime a user can currently select.

### Apparent compatibility differences checked before classification

- Cursor's [official changelog](https://cursor.com/changelog/cli-jan-08-2026)
  explicitly retains `cursor-agent`, and its [current installer](https://cursor.com/install)
  still creates both names. The installer was read as text, not executed.
  Cognia's command is not broken merely because new docs prefer `agent`.
- Factory's public manual uses `--output-format acp`, but the
  [official Registry manifest](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json)
  uses `acp-daemon`, retained in the
  [2026-10-24 update](https://github.com/agentclientprotocol/registry/commit/4bb90a94464c6f2b33376d9b7f7b3da26f5c710a).
  Cognia matches that manifest; no launch defect is established by the naming difference.
- DeepSeek now publishes [`@deepseek-ai/dsh`](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest),
  observed version `0.2.1-rc.2` with `bin: {"dsh":"lib/bin.js"}`.
  The unqualified “ships no binary of its own” comment in the CLI process
  validator is stale. The backend command's narrower statement about the
  transports Cognia drives is a different claim: npm distribution existence
  does not establish SDK/ACP compatibility or replace the pinned managed home.
- Kiro's [migration guide](https://kiro.dev/docs/cli/v3/acp-migration/)
  distinguishes `kiro-cli acp` from explicitly selected V3. The existing client
  already prefers `session/set_config_option` for advertised model options;
  complete V3 startup, approval, tool and resume behavior still needs acceptance.

## Current implementation evidence

- [Preset definitions](../../lib/ai/agent/external/config/presets.ts)
  and [ecosystem surfaces](../../lib/ai/agent/external/ecosystem-adapters.ts).
- [Runtime/version/platform catalog](../../protocol/external-agent-runtimes.json)
  and [launch/state policy](../../protocol/external-agent-security-policy.json).
- [Protocol factories](../../lib/ai/agent/external/manager.ts),
  [selectable protocols](../../lib/ai/agent/external/protocol-options.ts), and
  [admission checks](../../lib/ai/agent/external/capability/capability-preflight.ts).
- [Dormant registry discovery](../../lib/ai/agent/external/lifecycle/service.ts)
  and [registry classifier](../../lib/ai/agent/external/lifecycle/registry-discovery.ts).
- [Oh My Pi declarations](../../packages/agent-omp/src/manifest.ts)
  and [explicit package integration boundary](../../packages/agent-omp/README.md).
- [CLI command validator](../../cli/src/runtime/external/node-backend.ts),
  [Rust host policy](../../crates/cognia-external-agent/src/presets.rs), and
  [terminal PTY implementation](../../crates/cognia-terminal/src/session.rs).

### Runtime evidence remains version- and environment-scoped

Existing repository evidence is stronger for some routes, but it is not a new
run by this audit and must not be generalized to all 16:

- [Kimi 2.2.0 report](../reports/kimi-code-2.2.0-2026-10-18.md)
  records authenticated sandboxed ACP, tools, MCP, model selection and resume.
- [Copilot report](./2026-10-23-copilot-cli-support-audit.md)
  records real CLI/loopback checks and a native GitHub provider reply; some
  BYOK and app/device branches remain open.
- [Antigravity evidence](./2026-10-24-gemini-antigravity-cli-support-audit.md)
  records account-free real ACP/sandbox checks; authenticated inference and
  native app acceptance remain separate blocked branches.
- [Goose 1.56 evidence](./2026-10-25-goose-v156-support-audit.md)
  records actual binary and deterministic-provider checks. Runtime catalog
  certification still lists 1.52.0 rather than declaring all newer releases
  certified.
- [Codex 0.163.0 report](../reports/codex-app-server-2026-10-18/README.md)
  records a real CLI against a synthetic local provider, not authenticated
  service acceptance.

## Checks executed in this audit

Environment: macOS/Apple Silicon, Node `v26.12.1`, pnpm `11.18.0`.
Source baseline HEAD was `333a076f4c6ab2c77019a8dc3a4edafc19869954`, with extensive
pre-existing uncommitted changes. The matrix follows the working tree, not
that commit alone.

```sh
rtk proxy pnpm test --runInBand --runTestsByPath \
  lib/ai/agent/external/ecosystem-adapters.test.ts \
  lib/ai/agent/external/config/presets.test.ts \
  lib/ai/agent/external/config/install-catalog.test.ts \
  lib/ai/agent/external/protocol-options.test.ts \
  lib/ai/agent/external/lifecycle/registry-discovery.test.ts \
  packages/agent-acp/src/registry.test.ts
```

Result: **5 suites passed, 1 failed; 179 tests passed, 2 failed**, no coverage.
Both failures are in `protocol-options.test.ts`: tests expect legacy
`opencode` to be unselectable, while the current executable protocol list
includes it and the manager registers its factory. The audit does not decide
whether the intended V1 retirement or the retained compatibility route should
win by merely weakening either assertion.

```sh
rtk proxy pnpm audit:external-agent-runtimes
```

Result: generated JSON freshness passes, normal governance gate exits 1.
The checker reads `ExternalAgentPresetId` from the app preset file, but that
type is now owned by
`packages/plugin-contract/src/lib/ai/agent/external/config/presets.ts`.
Its old-path regex returns no IDs and falsely reports every catalog preset as
unshipped. A read-only diagnostic calling the existing `runChecks` with the
actual owning type source finds **27 preset IDs and zero errors**. This
diagnostic does not turn the normal failing command into a passing gate.

No installation, credential selection, authenticated inference, actual Tauri
UI flow, Windows/Linux runtime acceptance, full build, full lint or typecheck
was performed by this documentation-only audit.

### Reproducibility artifacts

Local task artifacts are under `.cache/agent-support-audit-2026-10-27/`:

- `source-snapshot.json`: all 34 mappings, counts, and hashes of owning sources.
- `upstream-a.md`, `upstream-b.md`: primary-source research and observed upstream
  repository/npm metadata, including exact dates and limitations.
- `catalog-tests.log`, `runtime-gate.log`, `gate-diagnostic.json`: actual checks.

These cache files are local supporting artifacts; primary upstream links and
the complete support matrix are retained in this ledger.

## Baseline audit residual risks

| ID  | Residual                                                                                 | From   | Why still open                                                               | Next action                                                                                       | Status |
| --- | ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| X1  | OpenCode V1/V2 picker behavior disagrees with two existing tests.                        | V3, R2 | Concurrent source retains V1 while tests express retirement.                 | Decide supported V1 compatibility policy, then align source and behavioral tests.                 | open   |
| X2  | Standard runtime governance command fails after preset-type ownership moved.             | V4, R2 | Checker still parses former source path.                                     | Repair checker to read the actual contract or canonical exported data; add relocation regression. | open   |
| X3  | Upstream existence does not prove paid-service/account or latest-version runtime health. | R3     | No current authenticated per-agent executions were performed.                | Use isolated per-version acceptance for each intended release and supported host.                 | open   |
| X4  | Kiro V3 needs version-specific acceptance; documented V2 remains a valid separate route. | R2     | V3 startup and behavior have not been executed here.                         | Inspect installed generation and test actual native startup and negotiated capabilities.          | open   |
| X5  | Seventeen missing presets and the unregistered Oh My Pi package remain integration work. | R2     | Audit does not implement host preparation, policies, factories or UI wiring. | Prioritize six documented native ACP candidates; review Oh My Pi host/guard boundary separately.  | open   |

## Outcome

These two signals record the initial audit disposition; the follow-up execution
paths and verification record below supersede its implementation counts.

| ID  | Signal                                                                     | How / when measured                                 | Result                                                                                                      | Status |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Every requested product has a lifecycle/source-support disposition.        | 34-row matrix and AST/catalog snapshot, 2026-10-27. | 16 registered, 1 package-only, 17 not built in; all 34 current identities have upstream existence evidence. | met    |
| M2  | Discontinued predecessors are excluded without deleting active successors. | Exact archive/migration notices, 2026-10-27.        | Old Python Kimi and Go OpenCode excluded; current Kimi, Crush, OpenCode and moved Kilo/Goose retained.      | met    |

### Baseline audit review record

The audit changes only this dated ledger. Ledger validation reports zero errors
and zero warnings; Prettier check passes. The final review confirms exactly 34
unique, sequential matrix rows, no broken local links and no drift in the 11
hashed owning sources. Results are retained in `final-review.json`.
Product remediation and actual runtime acceptance remain the open residuals
above; this ledger therefore remains in `verifying` status.

## Implementation follow-up — 2026-10-27

The implementation follows ADR-0217: protocol packages own wire formats and
lifecycle, application factories inject existing host ports, and native-only
entry points remain outside browser bundles. New packages are necessary for
OpenClaude bidirectional stream-json, Crush private HTTP, Continue final JSON,
Rovo Dev owned authenticated HTTP, and Codebuff SDK; these contracts cannot be
truthfully represented as ACP or generic terminal output.

### Resulting execution paths

| Products                                                                           | Application integration                                                                                                     | Limits enforced                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auggie, Autohand Code, CodeBuddy, Command Code, Kilo Code, MiMo Code, Mistral Vibe | Existing ACP package with explicit vendor profiles and native argv.                                                         | Negotiate optional features; reject unsupported permission ceilings and mandatory approval policies before session RPC; no invented native mode flags. Command Code uses `commandcode`, avoiding Windows `cmd`.                                                                    |
| Muse, Amp, ZCode                                                                   | Source-inspected ACP bridges and registered application profiles.                                                           | Muse requires its native login and session-MCP permission. Amp requires explicit unrestricted permission mode and rejects host-enforced mandatory tool approval. ZCode uses its signed-in macOS desktop engine; native terminal route is also available.                           |
| Oh My Pi                                                                           | `omp acp` profile registered in the application, using guarded host file/terminal ports.                                    | Refuses hosts without required guarded ports; actual 18.13.1 account-free native lifecycle checked below.                                                                                                                                                                          |
| OpenClaude                                                                         | New `agent-openclaude` package, registered `openclaude-cli` factory, native stream-json with mandatory permission hook.     | Independent `.openclaude` state; exact native resume, permission/questions, streaming steps, cancellation and cleanup. Native file-shaped `.openclaude.json` remains a file.                                                                                                       |
| Crush (Charm)                                                                      | New `agent-crush` package and `crush-http` factory; verified Node helper owns private Unix socket and actual `crush` child. | No unauthenticated TCP fallback or arbitrary executable injection; fixed native command; owner-only short socket path; native state and private host temp grants.                                                                                                                  |
| Continue                                                                           | New `agent-continue` package and `continue-cli` factory; actual `cn -p ... --format json`.                                  | Final-result semantics and host history replay; no fabricated streaming tool events or native resume ID. Read-only Plan / explicit unrestricted modes only.                                                                                                                        |
| Rovo Dev                                                                           | New `agent-rovo` package and `rovo-http` factory; host-owned `acli rovodev serve`.                                          | Random per-lease bearer challenge rejects token-ignoring listeners; fixed process launch; no caller-selected service endpoint.                                                                                                                                                     |
| Codebuff                                                                           | New `agent-codebuff` package and `codebuff-sdk` factory; SDK 0.10.7 in verified separate Node closure.                      | Mandatory OS network-off, intercepted first-party fetch with PII gate, confined filesystem and brokered native tools. No SDK dependency in renderer. Exact completed SDK resume state. Unsupported native MCP/OAuth and mandatory policy combinations fail closed.                 |
| Freebuff and generic installed CLI                                                 | Existing PTY host/dock plus managed terminal profile/session UI, mounted in settings and chat manager.                      | Explicit cwd, launch deduplication, real status/interaction/reopen, failed-stop retry, stop and cleanup; terminal capability limits shown. No claim of structured tool/permission parity.                                                                                          |
| Hermes Agent                                                                       | Registered ACP profile, controlled foreground gateway/viewer, strict verified helpers.                                      | **User deferred Hermes testing.** Native Python/dependency closure and short IPC grants remain unresolved. Unwired grant experiments were removed from source and archived; no broad read/tmp grants or unmanaged daemon fallback was enabled. Do not classify Hermes as accepted. |

The original 17 missing products plus Oh My Pi now have reachable application
routes: 17 structured configurations (including deferred Hermes) and Freebuff
managed terminal. ZCode also has a native terminal alternative. A current
upstream product was not removed merely because a predecessor was archived.
The original matrix above remains the pre-change inventory.

### Runtime and safety repairs

- OpenCode V1 auto-spawn and V2 remain executable compatibility routes. Tests
  now assert both are selectable; only the documented remote V1 preset stays
  disabled. The runtime gate reads the actual closed exported preset union via
  TypeScript AST and rejects missing, malformed, empty or open declarations.
- Desktop/settings/mobile configuration preserves native local-service process,
  cwd and env; fixed bridge commands/arguments cannot become a generic Node
  script launcher. Quick-add persists supported isolated/shared state explicitly,
  instead of inheriting an incompatible isolation default.
- Four fixed verified Node resources have embedded build pins, complete SDK
  asset/dependency inventory and revalidation at spawn. Generic Node/shell
  execution is not allowlisted. CLI pkg/Bun layouts carry the closure and use
  an actual verified plain Node interpreter, rather than the Cognia executable.
- macOS 26 strict sandbox initially killed even `/bin/echo` and Node in dyld.
  The minimal fix allows data access to the literal root directory for loader
  enumeration, without recursive host reads. A real sandbox regression also
  proves an ungranted private file remains unreadable.
- Codebuff Git inspection disables repository-controlled external diff,
  textconv and signatures; hostile-repository reproduction now passes. Tests
  exercise the real Node entry over JSONL, filesystem escape and symlink races,
  policy approval, subprocess refusal, cancel/EOF and cleanup. PII tests now
  reach the allowed first-party sink and include an allowed positive control.
- Native vendor CLIs retain their own provider behavior. Cognia-origin prompt,
  history, file and tool-response boundaries use existing outbound gates; this
  does not claim every native vendor network request has SDK-style interception.
- Ordinary native staging now verifies the complete existing closure and avoids
  rewriting unchanged watched files; extra/tampered output is still replaced.
  This addresses repeated Turbopack filesystem settling during acceptance.

### Verification record

All local artifacts below are under `.cache/agent-support-audit-2026-10-27/`.
No coverage run, commit, push or modification of unrelated changes was made.

| Check                                              | Actual result                                                                                                                                                     | Evidence / scope                                                                                                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined affected Jest                             | 71 suites, 1,688 tests, 1 snapshot passed; runner exited normally 0.                                                                                              | `final-affected-jest.log`, `final-test-paths.json`. Includes five native packages, factories, forms, catalog, settings, terminal management, host verifier and sandbox launcher.                                                               |
| ACP / OpenClaude focused integration               | 30 suites / 626 tests passed.                                                                                                                                     | `owned-a-tests.log`; includes source-derived wire fixtures and real local child/socket fixtures, not authenticated upstream inference.                                                                                                         |
| Five package builds and isolated tarball consumers | Passed ESM/CJS/declarations and consumer checks.                                                                                                                  | `pack-openclaude.log`, `pack-crush.log`, `pack-continue.log`, `pack-rovo.log`, `pack-codebuff.log`.                                                                                                                                            |
| Runtime/capability/staging/release Node gates      | 87 tests passed including the staging no-churn/tamper regression.                                                                                                 | `final-node-gates.log`, `stage-watch-red.log`, `stage-watch-green.log`.                                                                                                                                                                        |
| Runtime and capability governance                  | Passed: 41 runtimes, 44 presets, zero unpinned launches waived.                                                                                                   | `deterministic-final.json`; both generated catalogs fresh.                                                                                                                                                                                     |
| Static export / companion API / i18n build check   | Passed.                                                                                                                                                           | `deterministic-final.json`; 962 remote commands /119 classified routes, no Node-only browser import, both ICU catalogs valid.                                                                                                                  |
| Full lint                                          | Passed.                                                                                                                                                           | `lint-final.log`; scoped final Prettier check also passed.                                                                                                                                                                                     |
| Full root typecheck                                | **Failed: 11 diagnostics outside task-owned paths.**                                                                                                              | `typecheck-final.log`: missing ContextPanelDefinition.activity in context-workbench tests; mock tuple/unknown types in use-claude-chat tests; Discord avatar BigInt literals under current TS target. No complete root typecheck pass claimed. |
| Sidecar typecheck                                  | Passed independently after root check short-circuited.                                                                                                            | `sidecar-typecheck.log`; all configured sidecar checks completed.                                                                                                                                                                              |
| Rust execution sandbox                             | 224 tests passed, including actual macOS restricted execution and denied private-file read.                                                                       | `final-exec-sandbox.log`.                                                                                                                                                                                                                      |
| Tauri compile check                                | `cargo check -p cognia-next --features agent-debug` passed.                                                                                                       | `tauri-check.log`; build-generated permission includes new command. Actual isolated native IPC passed; full shell boot remained blocked in local account registry.                                                                             |
| Codebuff actual isolated SDK startup               | Passed SDK 0.10.7 ready, zero host network requests, EOF exit0, mandatory network-off OS sandbox.                                                                 | `codebuff-os-smoke.log`; genuine staged SDK/assets outside repo, synthetic noncredential key, no model request.                                                                                                                                |
| Oh My Pi actual native lifecycle                   | Passed official18.13.1 initialize, session/new, config, idle cancel, close, EOF exit0 and child cleanup.                                                          | `native-omp/acceptance.json`, `native-omp/cleanup.json`, `native-omp/README.md`; private HOME/workspace, current native launcher, networkoff, zero prompts/credentials/provider requests. Inference-time cancellation not certified.           |
| CLI compiled Bun and release layout                | Passed real Bun1.4 to verified Node26.12.1, adjacent closure, rejected self-alias/preload, sticky interpreter identity; 74 focused Jest and12 build tests passed. | `cli-bun-resolver-smoke.log`, `cli-bun-node-stage-smoke.log`, `cli-release-build-green.log`. No cross-platform release artifact claimed.                                                                                                       |
| Browser / native UI / production static build      | Pending current isolated acceptance.                                                                                                                              | Dedicated3103 frontend; original3000 frontend and another native process belong to concurrent work and remain untouched. Native audit uses a private application identifier and data directory.                                                |
| Hermes                                             | Skipped by explicit user request.                                                                                                                                 | `check-repair/deferred-hermes-runtime/README.md`; failed grant fixtures are recorded, not counted as accepted.                                                                                                                                 |

### Independent review synthesis

PII, static-export, wiring, i18n, Tauri/Rust and co-located-test auditors reviewed
the scoped change. Findings led to concrete fixes for CLI release closure,
Codebuff Node IPC coverage and Git execution, native permission ceilings,
Crush host grants/command identity, quick-add isolation and OpenClaude file
roots. Matching English/Chinese keys exist; generated sources were built.
Hermes grant findings remain deferred under the user instruction rather than
being hidden by fixture-only results.

### Final local verification corrections

The broad test run exposed two further stale picker tests (legacy OpenCode
wrongly disabled; fixed keyboard order after catalog expansion). Both were
corrected without weakening selectable/disabled behavior. Real Node-entry
fixtures now stop their esbuild services. Inspector evidence traced the final
remaining timer to an existing Pi registration test that created the real
manager without disposing it; test-only finally cleanup fixed that leak.
The final71-suite run exited normally0 with1,688 tests passed.

Rust external-agent final run:353 passed, 0 failed, 1 Hermes-named test filtered
under the user deferral (`final-external-agent-rust.log`). No coverage collected.

Native audit process group92437/app93795/monitor95904 all stopped. The original
native PID82991 and port3000 frontend were preserved. IPC returned typed pinned
bridge launch objects and rejected unknown identities. Full UI stayed in account
registry unlock, screenshot timed out, and no adjacent heavy native page was
accepted. `native-tauri/README.md` and `cleanup.json` record the limitation and
cleanup; do not turn that partial seam result into a full smoke pass.

Browser acceptance completed on Chromium and Pixel7 viewport:2 tests each,
0 failures/retries. All16 non-Hermes structured presets were enabled; actual
OMP/Crush/Rovo/Codebuff form contracts and OMP/Codebuff persisted configs survived
reload. Freebuff/ZCode unavailable-host limits were verified. A browser without
a terminal Host cannot prove actual PTY launch/interaction/stop/cleanup. Screenshots
and exact scope are retained in `e2e/RESULTS.md`. Owned3103 server and its4.8GiB
cache were removed after acceptance; original3000 service remained untouched.

All five protocol package ESM/CJS/DTS builds passed again after final sources.
Crush and Codebuff final isolated tarball consumer checks passed again after
native/security changes (`pack-crush-final.log`, `pack-codebuff-final.log`). The
final pinned SDK actual OS smoke passed again (`codebuff-os-smoke-final.log`).

## Residual risks

| ID  | Residual                                           | From   | Why still open                                                                                                                                               | Next action                                                                                            | Status   |
| --- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------- |
| X6  | Hermes native acceptance and exact runtime grants. | R2, R3 | User explicitly requested skipping Hermes tests; strict installation closure/socket grants unfinished. Accepted deferral does not mean runtime acceptance.   | Resume as a separate acceptance/fix pass when Hermes is available; preserve fail-closed behavior.      | accepted |
| X7  | Authenticated provider turns for new products.     | R3     | No accounts/credentials supplied; source and protocol fixtures do not establish provider availability.                                                       | Isolated per-product authenticated tool/approval/cancel/resume checks with intended accounts/versions. | open     |
| X8  | Root typecheck red outside scoped paths.           | R3     | Eleven diagnostics in concurrent context-workbench/chat/Discord work.                                                                                        | Owning changes correct listed diagnostics, then rerun official typecheck.                              | open     |
| X9  | Full native/PTY/production build acceptance.       | R3     | Browser checks passed; native account bootstrap and real terminal Host flow remain blocked, and production build is running in a verified APFS source clone. | Record actual results below, preserving concurrent services.                                           | open     |
| X10 | Foreign-platform packaging/runtime.                | R3     | Workstation is macOS ARM; no Windows/Linux device acceptance.                                                                                                | Run relevant device/release workflows before platform-wide certification.                              | open     |
| X11 | Initial OpenCode V1/V2 picker test disagreement.   | V3, R2 | Follow-up repaired stale retirement assertions, preserved executable V1/V2 and documented-only remote route; affected assertions now pass.                   | Keep compatibility regression tests.                                                                   | closed   |
| X12 | Initial runtime parser ownership failure.          | V4, R2 | Follow-up uses the actual owning closed union and rejects missing/malformed/open declarations; official gate now passes.                                     | Keep parser relocation and malformed-input regressions.                                                | closed   |
