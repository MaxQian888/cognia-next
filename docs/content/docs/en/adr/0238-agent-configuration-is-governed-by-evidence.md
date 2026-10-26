---
title: "0238 — Agent configuration is governed by evidence"
description: "Adds ctx.agentConfig, a governed read model over every text an agent loads, and the built-in Config Governance plugin, which audits that configuration with an adapted prompt-audit method, replays rules over past sessions to see whether they are followed, enforces the ones that are not through tool hooks, and verifies changes with before/after adherence and eval A/B."
---

# ADR 0238 — Agent configuration is governed by evidence

**Status:** Accepted
**Date:** 2026-10-20
**Related:** ADR-0122, ADR-0189, ADR-0198, ADR-0236, ADR-0237

## Context

What an agent loads as instructions is spread over many owners: repository instruction files
(`CLAUDE.md`, `AGENTS.md` and their layers), markdown agent files under `.claude/agents`,
Skills, characters and their variants, subagent and team templates, custom modes, presets,
workspace instructions, the default system prompt, and the shipped prompt slots. ADR-0236 put
the texts behind one Prompt Center, and each keeps a single owner. Nothing yet asks whether
the texts are still right.

Three questions make up that governance, and each needs different evidence:

1. **Should this rule exist?** A rule can be dated (shouted emphasis, thinking scaffolds,
   workarounds for older models), brittle (a path that is gone, a script that was renamed,
   two files that disagree) or simply never used.
2. **Is it followed?** A rule the agent ignores is not doing its job, however well it is
   worded. Only the agent's past tool calls can answer this.
3. **Did changing it help?** An edit is a hypothesis until adherence or an eval says otherwise.

### Assessment of the source material

The design draws on a set of Anthropic and community tools for Claude Code. Each solves part
of the problem. None can be installed into Cognia as is: they assume one runtime, a working
tree on disk and a model family, and several read files that can hold secrets.

- **`prompt-audit.md`** (Anthropic, Apache-2.0) is the strongest part. It names concrete
  anti-pattern groups, keeps an explicit *keep list* of things that look like cruft but are
  load-bearing, reports every finding with location, evidence, pattern, reason, confidence and
  action, only proposes edits for high or medium confidence, orders conflicts by version
  control dates only, and never lets a file's claims about itself decide. Its limits: it is
  tuned to Claude models of one generation, it reads a working tree, its verdict is a single
  model's judgment, and it deliberately skips `settings*.json`, MCP configuration and hook
  configuration because they can hold secrets — so it cannot tell that a prose rule is already
  enforced by a hook. **Adopted** as the audit method, vendored unchanged and pinned at
  `9d630808e4add0a7146de4af9384155d5dee350a`, and adapted (below).
- **`claude-md-management`** keeps instruction files current by revising and appending. On its
  own it grows files: there is no counter-pressure that removes text. **Adopted only** as "write
  the result back through the owner"; never as automatic appending.
- **`claude-md-doctor`** measures whether instructions are followed by reading session
  transcripts. This is the only evidence for question 2. Its transcripts are Claude Code's.
  **Adopted** as a deterministic backtest over Cognia's own stored tool calls, normalized across
  runtimes, with user-labelled false matches and a context-dilution signal.
- **`skill-creator`** evaluates a Skill with test prompts. Cognia already has an Eval Lab with
  datasets, scorers and pass@k. **Adopted** as eval A/B through `ctx.eval`, not as a second eval
  runner.
- **`hookify`** turns a rule into a Claude Code hook. Cognia plugins already receive
  `onPreToolUse` / `onPostToolUse`. **Adopted** as plugin-owned enforcement rules; the user's
  Claude Code hook files are never written.
- **`ngmeyer/claude-md`** is an opinionated template set with little evidence behind its choices.
  **Not adopted**; its size and structure advice survives only as the oversized-Skill signal.
- **`claude-code-setup`** recommends a first configuration. Onboarding (ADR-0122) owns that in
  Cognia. **Not adopted.**
- **`plugin-dev`** is Claude Code's plugin authoring kit. Cognia has its own SDK. **Not adopted.**
- **"Option B"** from the same material — a governance plugin with a `normalize.py` that parses
  every runtime's files into one findings JSON — has the right output (one finding schema for
  every source) and the wrong input: a plugin that parses configuration files must read the
  secret-bearing ones too. **Adopted** as a unified finding model over a host read model, so
  the plugin never parses a file.

## Decision

### `ctx.agentConfig`: a governed read model, written back through owners

A new plugin namespace exposes the agent's configuration without exposing how it is stored:

- `listSurfaces` / `readSurface` — every surface the Prompt Center lists (through its owner
  adapters) plus markdown agent files, with load order, layer, path, edit capability, a version
  precondition and, for Skills, usage and validation facts.
- `readFacts` — a **structural** summary of what is already enforced: hook event, matcher, type
  and a safe label (an executable's base name, never arguments, environment, headers or prompt
  text); permission rules as tool, pattern and verdict, with credentials a remembered command
  carries masked and a row that would still leak dropped; MCP servers as id, transport and
  enabled state; Skill counts. The settings files themselves are never returned.
- `checkReferences` — whether paths an instruction names exist inside the workspace's roots
  (links are reported and never followed; anything outside the roots is not probed) and whether
  package scripts are defined.
- `readProvenance` — per-line commit and time from version control, with no author.
- `redactForModel` — the host's PII redaction, line-preserving; `null` when the text cannot be
  made safe.
- `applyEdit` — writes a complete new text through the owner (a file, a Prompt Center override
  with origin `plugin`, or a custom copy of a shipped resource). Every surface is a separate
  consent prompt showing the plugin's summary; a stale version is refused.

Permissions are `agent-config:read` and `agent-config:write` (sensitive; writes need
confirmation). `ctx.eval.runDataset` gains `cwd`, validated against the workspace roots, so an
eval runs against one repository's instructions. Two host defects found on the way are fixed:
a plugin's `denyReason` now reaches the model, and the Prompt Center accepts
`?resource=&workspace=` deep links.

### The Config Governance plugin

A first-party, browser-builtin plugin (`plugins/config-governance/`) built only on the public
SDK. One finding model serves every source, so a rule reported by a signal, the reference check
and the model is one finding with three sources.

**Audit (question 1).** Per surface: segment into rule units; run the prompt-audit signals as
leads; check named paths and scripts; date lines from version control; then — only when a model
is configured and the text can be redacted — ask for a judgment and **validate** it: a known
pattern, real line numbers, evidence quoted from those lines, a replacement for a rewrite and a
known destination for a move, otherwise a flag. Signals the model saw and did not confirm are
dropped; without a model they remain low-confidence flags. A conflict pass asks once about rule
pairs from surfaces that load together and edits only the older side when the dates order the
pair; it never weakens a prohibition or adds a command on its own. Hunks are computed against
the original text, never the redacted copy; a write over a redacted line is withheld. Conflict
and stale-fact edits are *proposed only*: never selected for the user.

Adaptations to the method: the target model is a setting, not assumed to be Claude, and claims
about model behavior are conditional on it; hooks and permission rules arrive as host facts;
request code (the method's Group 4) is out of scope because users do not write Cognia's request
builder; all model-facing wording is a Prompt Center slot.

**Adherence (question 2).** Rules plausibly about tool use are turned into checks by one model
call — `forbid`, `require-after`, `require-before`, over shell / edit / read calls with a
command pattern and a path glob, within the turn or the session. Command patterns are refused
when they could backtrack catastrophically and only run on a bounded prefix. Replaying is local
and free: opportunities, followed, violated, samples, user-labelled false matches excluded, and
the violation rate in the early versus late half of long sessions. A rule that is not followed
becomes an `enforce` finding; late breakage becomes a dilution flag (its position, not its
wording, is the likely fix); a rule that never applied across enough sessions is flagged as
possibly obsolete.

**Enforcement.** A user can adopt a check as a rule for one workspace or every session: *remind*
appends the rule to the tool's text result; *block* denies the call with the rule as the reason.
A `require-after` rule cannot block a call that has not happened and always reminds. Rules run
in the plugin's own hooks, fail open, and pause with one setting.

**Verification (question 3).** For every applied change: replay the same checks over sessions
created before it and since; and run an eval dataset in the workspace as baseline and candidate.
Each comparison says whether it has enough data before it says better or worse.

**Surfaces.** A rail view with Overview, Findings, Adherence, Enforcement, Verify and Inventory
tabs, linking each surface to its Prompt Center entry; `/governance [audit|adherence|open]`; a
palette quick action; two read-only agent tools (`config_governance_report`,
`config_governance_adherence`) with a playbook Skill that tells the model it cannot apply
changes; five Prompt Center slots; and a weekly drift check that re-audits without a model and
notifies when a surface changed or a new high-confidence finding appeared — paused until the
user resumes it. Storage is bounded to stay inside the plugin quota and never holds a whole
surface.

## Consequences

- Governance tooling reads configuration through owners instead of files, so it works the same
  for a repository file, a Skill and a character, and cannot read a credential by construction.
- A finding is evidence plus a proposal; edits are taken one surface and one confirmation at a
  time. The audit never changes anything on its own.
- The plugin registers `onPostToolUse`, which engages tool-result review for every tool call
  while it is enabled; with no adopted rules the hooks return at once.
- The adherence backtest sees only tool calls. Rules about tone or judgment are reported as
  not checkable instead of being given a proxy.
- Eval A/B spends model calls and is only ever started by the user.

## Alternatives considered

- **Install the Claude Code plugins.** They target one runtime and its file layout, and two of
  them read secret-bearing settings. Rejected.
- **Parse configuration files in the plugin (Option B).** Rejected: the plugin would need to
  read the files that hold secrets, and every owner's storage rules would be duplicated.
- **Let the model's verdict stand.** Rejected: every judgment is validated against the text, the
  repository and version control, and low confidence never edits.
- **Write Claude Code hooks for enforcement.** Rejected: the hook files are the user's and can
  hold secrets; plugin hooks cover every runtime Cognia drives.
