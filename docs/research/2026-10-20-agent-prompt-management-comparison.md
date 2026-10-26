# Prompt management comparison: preserve resource semantics before adding a universal editor

- Date: 2026-10-20, Asia/Shanghai
- Scope: Codex, Claude Code, Gemini CLI, OpenCode and Cursor versus current Cognia code and the [management proposal](../plans/2026-10-20-built-in-prompt-management.md).
- Method: official documentation; commit-pinned OpenCode source; current Cognia source inspection; two synthetic local helper checks. No competitor installation, model benchmark, or application E2E.
- Evidence labels: **Confirmed** means documented or inspected behavior; **Reproduced** means the specific local helper-level check ran; **Inference** is a design conclusion; **Unmeasured** means a quality/performance/security outcome has not been established.

## 1. Keep the full UI, but revise what “unified” means

**Recommendation:** keep the requested complete editing/override interface, and unify discovery, source editing, provenance, diff, history and inspection. Apply resource-specific composition, scope, trust, activation and compatibility rules underneath it. A universal text-replacement model would erase important differences.

The comparison found two concrete Cognia assembly/identity problems worth fixing before relying on a new inspector, plus seven design gaps in the proposal. This is not evidence that Cognia lacks prompt budgets, project instructions or progressive Skills: those mechanisms already exist. It is evidence that the proposal must preserve and expose them explicitly.

The claim “mainstream agents never allow replacing built-in prompts” would be false. Official interfaces and stable source support replacement in several products. The relevant design lesson is to make the operation, consequences and affected runtime visible.

## 2. Five representative agents manage different resource types

These products are representative comparators, not a market-share ranking. Each has different scope; a CLI's file interface and an IDE's graphical management are not equivalent products.

| Product     | Confirmed relevant behavior                                                                                                                                                                   | Implication for Cognia                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `AGENTS.md` discovery builds an ordered, size-bounded instruction chain at run/session startup. Configuration separately exposes developer guidance and replacement of built-in instructions. | Separate instruction layering from full baseline replacement and show when a new session is required. [Instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [configuration](https://learn.chatgpt.com/docs/config-file/config-reference).                                                                                                                                                                  |
| Claude Code | Official CLI documents explicit append/replace operations; project guidance, Skills, subagent definitions and output styles have distinct semantics.                                          | Do not assign one edit operation or activation rule to every catalog entry. [CLI](https://code.claude.com/docs/en/cli-reference#system-prompt-flags).                                                                                                                                                                                                                                                                              |
| Gemini CLI  | Full system replacement is explicit; hierarchical project context has inspection/reload commands.                                                                                             | Expose the active source chain and distinguish inspecting a layer from the whole provider request. [System prompt](https://geminicli.com/docs/cli/system-prompt/), [context](https://geminicli.com/docs/cli/gemini-md/).                                                                                                                                                                                                           |
| OpenCode    | Stable `v1.19.3` selects model-family baseline prompts; a configured agent prompt can replace that baseline.                                                                                  | Track model/runtime compatibility and document replacement rather than assuming a universal base. [Pinned baseline selection](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/system.ts#L26-L48), [request assembly](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/llm/request.ts#L58-L118). |
| Cursor      | Its Customize UI creates project `.mdc` rules in `.cursor/rules`; rules support always, relevance, file-pattern and manual application.                                                       | A unified UI can edit canonical repository files and explain loading conditions. It need not mirror every resource into an account database. [Rules](https://cursor.com/docs/rules).                                                                                                                                                                                                                                               |

Detailed Claude/Gemini/OpenCode extraction, including source-version and reload caveats, is recorded in the [competitor evidence note](2026-10-20-agent-prompt-management-comparison-sources.md). Public docs are live as retrieved on this date; their behavior is not automatically the behavior of an arbitrary installed version. The OpenCode implementation comparison is pinned to tag commit `e3c4eb242585dcd77be1a867391b7c25fd47ce52`, not its evolving development branch.

Additional confirmed Codex distinctions: Skill metadata is discovered before the full body, with a separate discovery budget; custom subagent instructions do not replace inherited sandbox/approval settings. These are separate resource and authority contracts. [Skills](https://learn.chatgpt.com/docs/build-skills), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## 3. Two Cognia issues were reproduced at the helper boundary

### F1 — High: the composition prompt digest can omit instructions actually sent

**Confirmed and helper-demonstrated.** [build-options](../../lib/claude/build-options.ts) passes this value to `resolveTurnCompositionSafely`:

```ts
systemPrompt: opts.systemPrompt ?? opts.appendSystemPrompt
```

The [safe wrapper](../../lib/claude/resolve-turn-composition-safely.ts) forwards that single string; [resolve-turn-composition](../../lib/agent/composition/resolve-turn-composition.ts) hashes it. However, [standalone chat](../../lib/ai/chat/standalone-engine.ts) combines the base and append strings, and the [SDK options adapter](../../sidecar/src/runtimes/claude-agent-sdk/options.ts) calls [foldSystemPrompt](../../sidecar/src/runtimes/claude-agent-sdk/system-prompt.ts) with both.

Trigger: keep a non-null base and change only appended Plan, goal, output-style, or other guidance. The composition digest receives the same input while the SDK prompt changes. This is omitted hash input, not a SHA-256 collision. Other request-recording mechanisms may independently capture more content; this finding concerns the composition's `promptDigest`, not every possible trace.

The send assembler also has later special-session transformations, and the SDK adapter supports its own prompt overlay. An early composition digest should not be presented as proof of the complete provider request.

**Required revision:** distinguish template/profile selection identity from the fully translated request surface. Include every relevant segment and compute request-surface identity after the owning transforms. Add regressions where only append changes, the SDK overlay changes, or a special session replaces the assembled prompt. A Prompt Center cannot reliably explain “what ran” until that distinction is correct.

### F2 — Medium: user-authored marker text can suppress the subagent host frame

**Reproduced using the current exported function.** [composeSubagentSystemPrompt](../../lib/claude/agents/subagent-prompt-frame.ts) returns the supplied identity immediately when its text contains `<subagent_contract>` anywhere.

Trigger: define a custom identity containing that literal tag, even as an example. Supplying a valid cwd/platform/date still returns only the identity; the environment and host contract are omitted. A text substring is being used as evidence that a trusted assembly step already happened.

**Boundary of the claim:** this demonstrates loss of model-visible frame text. It does not demonstrate bypass of actual filesystem restrictions, tool grants, sandboxing or approval enforcement.

**Required revision:** carry framed/unframed state in host-owned structure or compose identity and host segments separately. Preserve idempotence without trusting an editable body to assert its provenance. Test literal tag examples, empty identity, already-framed trusted payloads and nested dispatch.

### Check output and limits

The local Node check imported the actual TypeScript `foldSystemPrompt` and `composeSubagentSystemPrompt` helpers. For F1 it also asserted the exact current coalescing expression in the source and compared its selected input; it did not invoke the complete send resolver or an external model.

```json
{
  "composition_digest_input_unchanged": true,
  "actual_sdk_prompt_changed": true,
  "custom_identity_marker_skips_host_frame": true
}
```

These checks passed on Node `v26.5.0`. They are diagnostic demonstrations, not regression tests added to the repository, a full request capture, or an exploit demonstration. Application code remains unchanged.

## 4. Seven design gaps need decisions before implementation

### D1 — High: scope specificity must not stand in for authority

The proposal's `session > agent > workspace > account > built-in` order is valid only for eligible overrides of one named slot. It is not a universal order among tool policy, managed constraints, repository instructions, Skills and task text. The previous plan states a slot qualification but does not make authority or resource operation first-class descriptor fields.

**Evidence:** Codex subagent definitions cannot override inherited permission settings; Cursor separates enforced team rules from personal/project guidance. These differ from “the closest scope wins.” [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Cursor rule ownership](https://cursor.com/help/customization/rules).

**Correction:** add resource kind, source/authority class, eligibility, allowed edit operation and activation policy. Evaluate capability and trust outside prose; choose applicable resources; resolve scope within a resource; then preserve ordered instruction composition. The UI can show conflicting instructions, but string concatenation cannot guarantee the model will obey an intended semantic priority.

### D2 — High: changing a role and replacing the runtime baseline need distinct controls

**Confirmed mechanism; unmeasured quality consequence.** Cognia's [base selection](../../lib/claude/build-options.ts) chooses a session/member/character/default string. A nonempty supplied prompt reaches the SDK [custom prompt form](../../sidecar/src/runtimes/claude-agent-sdk/system-prompt.ts); SDK prompt overlays introduce another choice. Short role text can therefore participate in a full replacement path, rather than merely adding a persona.

Replacement is supported elsewhere too, including the OpenCode path above. It is not intrinsically invalid. What is missing is an explicit product contract explaining the operation, baseline source, runtime/model/tool compatibility, and resources still present afterward. Neither official docs nor this source review establishes that one universal wording improves all models.

**Correction:** expose additive guidance, role definition and full baseline replacement as distinct actions. New ordinary personas should normally augment a known baseline; existing replacement-based sessions keep their behavior until explicitly converted. Advanced replacement remains available with an impact preview. Add compatibility keys for runtime/model family/tool contract and label external instructions that Cognia cannot observe or control. Portability means an interoperable definition, not identical bytes across unrelated harnesses.

### D3 — Medium: database revisions do not replace repository-native ownership

The prior proposal's generic revision tables are appropriate for code-only feature templates. Project rules and Skills also need a file-backed editor path. Treating filesystem instructions primarily as references would make the full UI less useful for team review, worktrees and other agents.

Cursor demonstrates that a graphical editor can write a canonical project rule file. Codex's documented instruction chain likewise consumes repository files. These are positive mechanisms, not evidence that every prompt must live on disk.

**Correction:** file-backed resources edit their owning files through existing workspace APIs with expected-content checks, root/path validation and visible Git changes. DB-backed characters/presets remain in their own stores. Generated/bundled defaults create custom overlays/copies rather than editing build output. A single resource has one active text authority; watcher refresh must not make a second DB mirror authoritative.

### D4 — Medium: “published” and “active in this session” are separate states

The plan freezes running operations and says changes affect the next eligible operation, but has no executable per-resource/per-runtime activation capability matrix. That is insufficient for backends whose initial system prompt or remote session is cached.

The competitor evidence contains different startup, watched-file, explicit reload and restart behavior. This diversity means Cognia needs negotiated behavior rather than a universal hot-reload promise.

**Correction:** each descriptor/runtime reports `next-operation`, `reload-required`, `new-session-required`, `checkpoint-adoption`, or `unsupported`. Show published revision, current active revision, and any pending change. Recreate an external session only through its existing lifecycle contract; never imply that changing a local editor can replace an upstream provider's hidden instructions.

### D5 — Medium: lazy UI loading is not a model context budget

Cognia already has [Skill delivery policies](../../lib/skills/delivery.ts) and a [budget/degradation ladder](../../lib/skills/prompt-budget.ts), including whole-body omission rather than sentence truncation. The prior proposal's lazy catalog/body loading mostly addresses application bundle/startup cost. It does not define a whole-operation policy for irrelevant, duplicated or conflicting guidance.

Codex documents budgeted Skill discovery; Cursor distinguishes short rules from invoked procedures. OpenAI also cautions that broad descriptions and over-prescriptive instructions can harm selection and consume context. [Codex Skills](https://learn.chatgpt.com/docs/build-skills), [Cursor rule/Skill distinction](https://cursor.com/help/customization/skills), [instruction maintenance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

**Correction:** register all resources for management without injecting the registry into every model call. Reuse existing delivery/budget logic. Show loaded, discoverable, inactive, omitted and truncated-metadata states. Budget static instructions, discovery metadata and dynamic data separately; protect required contracts; treat advisory conflict detection as a warning rather than a proof of consistent model behavior.

### D6 — High for approval-related activation: schema validity cannot certify behavioral compatibility

The earlier plan mentions evals but leaves the safety/quality activation bar largely undefined. A custom title template, a compaction prompt, a subagent identity and a command-judge prompt have very different failure costs.

In current [command-judge](../../lib/claude/permissions/command-judge.ts), cached verdict lookup is keyed by command/context. Adding editable prompt revisions without versioning that cache can reuse a verdict from a previous policy. This is a future integration hazard, not a current cache bug while the prompt remains constant.

**Correction:** include prompt/profile and relevant policy/model versions in affected result-cache keys; define behavior-oriented fixtures before enabling each editable cohort. Evaluate unsafe command handling, instruction conflict, output parsing, compaction retention, and external tool protocol—not just placeholders or JSON shape. Separate deterministic contract/wiring checks from measured model quality. Do not invent a claim that test fixtures eliminate prompt-injection risk. Permission decisions remain enforced by host policy, with an explicit activation policy for the model-judge component.

### D7 — Medium: the rollout is too dependent on universal infrastructure

The previous phase table makes a cross-package core, generic revisions, host management extensions, Rust adaptation and all advanced role editing prerequisites for final closure. Some breadth is inherent in the requested full UI, but the need for one general-purpose runtime resolver for every model-facing string has not been demonstrated.

**Correction:** keep the final complete management requirement, but independently verify four coherent cohorts: instructions/roles/Skills, ordinary feature templates, cross-host adapters, and advanced contract profiles. Extend existing owners first; extract a new package only when concrete independent consumers require it. Do not require database versions for file-backed edits or route all utility calls through chat assembly. Each cohort must have a working edit → active revision → actual consumer → reset flow; a catalog entry or a nonfunctional publish button does not count as delivery.

## 5. Amend the proposal with six explicit contracts

| Contract              | Required fields or behavior                                                            | Acceptance before expansion                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Resource identity     | Kind, stable ID, source owner, editable surface, authority and availability            | Two screens cannot create competing active copies                                                   |
| Composition           | Append rules, additive role, activate procedure, replace template, or replace baseline | Change one resource without silently deleting unrelated runtime guidance                            |
| Applicability         | Workspace/account/session/agent conditions plus model/runtime/tool compatibility       | Applicable and inapplicable resources explained for a real context                                  |
| Activation            | Published/active revisions and resource/backend-specific reload policy                 | Mid-operation edit and remote-session restart tests                                                 |
| Context budget        | Existing delivery policy, required segments, discovery budget and named omission       | Catalog growth cannot cause unconditional model-context growth                                      |
| Provenance/evaluation | Selection digest, final request-surface digest, cache identity and behavior fixtures   | Append-only edits change the relevant identity; host-owned frames cannot be forged by template text |

Suggested first implementation work is F1/F2 regression coverage and resolution, then the owner adapters and editor for instructions/roles/Skills plus one ordinary utility template. The rest of the complete management scope follows through explicitly supported cohorts. No production fix is performed by this research task.

## 6. Verification and remaining unknowns

- Confirmed official docs and pinned source mechanisms; source URLs support the claims at the relevant paragraphs.
- Ran the two synthetic Cognia checks above against actual pure helpers and the current source expression.
- Document validation covers formatting, local links and whitespace/conflict markers; no application build/test pass is inferred.
- No task-success, adherence, context-cost or safety improvement was measured. Baseline-versus-additive-versus-replacement evaluation needs fixed model/runtime/tool sets and comparable tasks.
- No claim that competitors lack a graphical editor, version history or enterprise controls follows from omitted documentation. Cursor is included specifically as an official graphical rule-management example.
- No claim that a published custom prompt can control hidden provider instructions or deterministically resolve natural-language contradictions.

Sources: official Codex and Cursor pages linked above; [Claude Code/Gemini CLI/OpenCode source extraction](2026-10-20-agent-prompt-management-comparison-sources.md); current repository modules linked in F1/F2 and the design findings. No unofficial prompt dumps were used.
