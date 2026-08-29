/**
 * Deterministic risk classifier for autonomous runs.
 *
 * Answers one question — "does this run owe a human a checkpoint before it
 * starts?" — from the run's *configuration* (which tools and capabilities the
 * roster can actually reach) plus a coarse read of its stated objective. No
 * LLM call: a safety gate must not depend on a model's mood, and a classifier
 * that can be prompt-injected by the very objective it is judging is worse than
 * no classifier. LLM augmentation is a later phase and must never become the
 * sole judge.
 *
 * **Gate on positive evidence, not on uncertainty.** The default tier is `low`
 * (proceed) unless a known-dangerous tool/capability or a destructive-intent
 * signal is positively detected. This diverges from a "gate-unless-proven-safe"
 * default on purpose: this is an end-user product, and a gate that fires on
 * every unrecognized tool trains operators to click through it — at which point
 * it protects nobody. Unknown ≠ risky.
 *
 * Tool/capability presence is the PRIMARY signal; the keyword sets are a coarse
 * secondary one, and only for intent that no tool id can express (destroying
 * data, handling credentials). Every rule below is pinned by a fixture in
 * `classify-risk.test.ts`. Per ADR-0070.
 */

import { RISK_SURFACES, type RiskSurfaceId } from "./risk-surfaces"

export type RiskTier = "low" | "medium" | "high"

export interface RiskInput {
  /**
   * The run's objective (`team.task`). Matched against keyword sets only —
   * it never reaches a model from here, so no PII redaction is owed.
   */
  objective: string
  /** Per-task descriptions, matched the same way as `objective`. */
  taskDescriptions: string[]
  /** Union of teammate `tools` + resolved `nativeAnthropicToolIds`. */
  toolIds: string[]
  /** Union of resolved mcp / skill / subagent / external-agent ids. */
  capabilityIds: string[]
  /** Team-level OR any-teammate sandbox, already resolved by the caller. */
  sandboxEnabled: boolean
}

export interface RiskSurfaceHit {
  id: RiskSurfaceId
  /** What tripped the rule — a tool id, a capability id, or a matched term. */
  evidence: string
}

export interface RiskAssessment {
  tier: RiskTier
  surfaces: RiskSurfaceHit[]
  /** One-line human summary, e.g. `high — computer-use, external-send`. */
  reason: string
}

/**
 * Tool ids are matched after normalization, because the same tool reaches us
 * under several spellings: `mcp__cognia-plugin-tools__computer_use` (MCP wire
 * name), `computer_use` (plugin tool id), `computer` (the native-anthropic
 * registry id the computer-use plugin registers), `computer_20251124` (the
 * Anthropic tool type). Matching the normalized tail against a known set beats
 * a substring search, which would classify `read_bash_history` as shell access.
 */
function normalizeToolId(id: string): string {
  const tail = id.split("__").pop() ?? id
  return tail.trim().toLowerCase()
}

/** Screen / mouse / keyboard automation. See `plugins/computer-use/src/index.ts`. */
const COMPUTER_USE_TOOL_IDS = new Set([
  "computer",
  "computer_use",
  "computer_20251124",
  "find_text",
  "click_text",
  "screenshot",
])

/** Shell / native command execution. See `lib/settings/builtin-tools-data.json`. */
const NATIVE_COMMAND_TOOL_IDS = new Set([
  "bash",
  "bash_20250124",
  "bash_output",
  "kill_shell",
  "shell_execute_advanced",
  "start_process",
  "terminate_process",
  "terminal_repl_spawn",
  "terminal_repl_write",
  "terminal_repl_kill",
])

/** Tools whose whole purpose is destroying something. */
const DATA_DESTRUCTIVE_TOOL_IDS = new Set(["directory_delete", "file_delete", "delete_file"])

/** Tools that write to the filesystem (broad only when unsandboxed). */
const FILE_WRITE_TOOL_IDS = new Set([
  "write",
  "edit",
  "multi_edit",
  "apply_patch",
  "file_append",
  "file_binary_write",
  "file_copy",
  "file_move",
  "file_rename",
  "notebookedit",
  "text_editor",
  "text_editor_20250728",
])

/**
 * Ids that let a run send to a recipient of its own choosing.
 *
 * Note what is deliberately NOT here: merely being bound to a connector
 * conversation. A team summoned from a Feishu thread replying into that same
 * thread is the feature working — the recipient is the person who asked, and
 * they are watching. Treating that as `external-send` would gate (and, headless,
 * refuse) every IM-bound team run, which trains operators to blanket-disable
 * `riskGating` and thereby lose the computer-use/shell gating that is the
 * point. The risk is sending somewhere the requester did not ask for, which
 * needs an agent-callable send tool — that is what this set catches.
 */
const EXTERNAL_SEND_IDS = new Set([
  "connector_send",
  "send_message",
  "send_email",
  // Publishing a Cognia Site puts a URL other people can load in front of the
  // world, and it cannot be unsent: `takeDown` removes the Site, it does not
  // restore the previous version. `build_site` produces an immutable local
  // version and is deliberately absent.
  "deploy_site",
])

/** Ids that reach secrets at rest. */
const CREDENTIAL_IDS = new Set(["keyring", "secrets", "secret_store", "subscription", "oauth"])

/**
 * Destructive intent no tool id can express. Deliberately small and
 * high-precision: every term here is a verb whose object is real data. `clear`
 * and `remove` are excluded — "clear up the docs" / "remove the duplicate
 * import" are ordinary work, and a false gate is a real cost.
 */
const DESTRUCTIVE_TERMS = [
  "delete",
  "drop table",
  "wipe",
  "truncate",
  "rm -rf",
  "purge",
  "删除",
  "清空",
  "重置",
] as const

/** Credential-handling intent, matched the same way. */
const CREDENTIAL_TERMS = [
  "credential",
  "password",
  "api key",
  "access token",
  "secret key",
  "凭证",
  "密钥",
  "密码",
] as const

/** `reset` alone is too broad (reset a counter, reset state); require an object. */
const RESET_TERMS = ["reset the database", "reset all data", "factory reset"] as const

function matchTerm(haystack: string, terms: readonly string[]): string | undefined {
  return terms.find((t) => haystack.includes(t))
}

/**
 * Classify a run. Order-independent: every rule is evaluated, the tier is the
 * max severity across all hits, and hits are returned so callers can name them.
 */
export function classifyRisk(input: RiskInput): RiskAssessment {
  const tools = new Set(input.toolIds.map(normalizeToolId))
  const capabilities = new Set(input.capabilityIds.map(normalizeToolId))
  const text = [input.objective, ...input.taskDescriptions].join("\n").toLowerCase()

  const hits: RiskSurfaceHit[] = []
  /** Severity overrides for rules the sandbox downgrades. */
  const downgraded = new Set<RiskSurfaceId>()

  const firstIn = (set: Set<string>, candidates: Set<string>): string | undefined => {
    for (const id of set) if (candidates.has(id)) return id
    return undefined
  }

  // ── external-send ──
  {
    const hit = firstIn(tools, EXTERNAL_SEND_IDS) ?? firstIn(capabilities, EXTERNAL_SEND_IDS)
    if (hit) hits.push({ id: "external-send", evidence: hit })
  }

  // ── computer-use ──
  {
    const hit = firstIn(tools, COMPUTER_USE_TOOL_IDS)
    if (hit) hits.push({ id: "computer-use", evidence: hit })
  }

  // ── native-command (sandbox downgrades: the OS sandbox confines the blast radius) ──
  {
    const hit = firstIn(tools, NATIVE_COMMAND_TOOL_IDS)
    if (hit) {
      hits.push({ id: "native-command", evidence: hit })
      if (input.sandboxEnabled) downgraded.add("native-command")
    }
  }

  // ── data-destructive ──
  {
    const toolHit = firstIn(tools, DATA_DESTRUCTIVE_TOOL_IDS)
    const termHit = matchTerm(text, DESTRUCTIVE_TERMS) ?? matchTerm(text, RESET_TERMS)
    if (toolHit) hits.push({ id: "data-destructive", evidence: toolHit })
    else if (termHit)
      hits.push({ id: "data-destructive", evidence: `objective mentions "${termHit}"` })
  }

  // ── credential-auth ──
  {
    const capHit = firstIn(capabilities, CREDENTIAL_IDS) ?? firstIn(tools, CREDENTIAL_IDS)
    const termHit = matchTerm(text, CREDENTIAL_TERMS)
    if (capHit) hits.push({ id: "credential-auth", evidence: capHit })
    else if (termHit)
      hits.push({ id: "credential-auth", evidence: `objective mentions "${termHit}"` })
  }

  // ── file-write-broad (only meaningful outside a sandbox) ──
  if (!input.sandboxEnabled) {
    const hit = firstIn(tools, FILE_WRITE_TOOL_IDS)
    if (hit) hits.push({ id: "file-write-broad", evidence: hit })
  }

  const severityOf = (id: RiskSurfaceId) =>
    downgraded.has(id) ? "elevated" : RISK_SURFACES[id].severity
  const tier: RiskTier = hits.some((h) => severityOf(h.id) === "high")
    ? "high"
    : hits.length > 0
      ? "medium"
      : "low"

  const reason =
    hits.length === 0
      ? "low — no risk surfaces detected"
      : `${tier} — ${[...new Set(hits.map((h) => h.id))].join(", ")}`

  return { tier, surfaces: hits, reason }
}
