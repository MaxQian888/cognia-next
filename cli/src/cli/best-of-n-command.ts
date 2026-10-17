/**
 * `cognia-agent best-of-n <start|status|list|cancel|select|publish|archive>`.
 *
 * Best-of-N runs in the desktop app: its renderer fans the attempts out,
 * runs exact-head checks and integrates the winner, and its Host ledger
 * authorizes every write. This command drives that through the CLI bridge
 * (`POST /api/dev/best-of-n/{action}`), the way `/team run` does.
 *
 * Choosing a winner is a person's decision. `select` and `publish` refuse
 * without an interactive terminal, refuse `--yes` and `CI`, ask on the
 * terminal, and then still meet the desktop's own native approval.
 */

import readline from "node:readline/promises"
import { detectDesktop, DEV_TOKEN_HEADER, type HandoffClientDeps } from "../handoff/client"
import type { BridgeEndpoint } from "../handoff/endpoint"
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export const BEST_OF_N_PATH = "/api/dev/best-of-n"
const ACTIONS = ["start", "status", "list", "cancel", "select", "publish", "archive"] as const
type Action = (typeof ACTIONS)[number]
/** Exact-head checks and the desktop's native approval can take this long. */
const DECISION_TIMEOUT_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 30_000

export const BEST_OF_N_USAGE = `Usage:
  cognia-agent best-of-n start --session <id> [--n 2|3|4] [--agents a,b,...]
                               [--target <new-branch> | --existing-branch <branch>] "<prompt>"
  cognia-agent best-of-n list [--json]
  cognia-agent best-of-n status <groupId> [--json]
  cognia-agent best-of-n cancel <groupId>
  cognia-agent best-of-n select <groupId> <candidate>   interactive terminal only
  cognia-agent best-of-n publish <groupId>              interactive terminal only
  cognia-agent best-of-n archive <groupId>

  --agents takes one entry per attempt: session, an external agent configuration
  id, or the preset of an enabled external agent (claude-code, codex, ...).`

interface CliCandidate {
  index: number
  candidateId: string
  status: string
  runtime: string
  agent: string
  model: string | null
  headSha: string | null
  hasChanges: boolean
  costUsd: number | null
  error: string | null
}
interface CliRun {
  groupId: string
  phase: string
  n: number
  baseSha: string
  targetRef: string
  selectedCandidateId: string | null
  archiveStatus: string
  error: string | null
  candidates: CliCandidate[]
}
interface BridgeResult {
  ok: boolean
  error?: string
  runs?: CliRun[]
  run?: CliRun
  checks?: Array<{ profileId: string; outcome: string; headSha: string }>
  requiredChecks?: string[]
  outcome?: { kind: string; reason?: string; message?: string }
  archiveError?: string | null
  releaseError?: string | null
}

export interface BestOfNCommandDeps extends HandoffClientDeps {
  out?: OutputSink
  endpoint?: BridgeEndpoint | null
  /** Whether stdin and stdout are both a terminal. */
  isTty?: () => boolean
  /** Ask one question on the terminal; null when it cannot be asked. */
  ask?: (question: string) => Promise<string | null>
}

async function defaultAsk(question: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } catch {
    return null
  } finally {
    rl.close()
  }
}

async function call(
  action: Action,
  payload: Record<string, unknown>,
  deps: BestOfNCommandDeps
): Promise<BridgeResult> {
  const endpoint = deps.endpoint !== undefined ? deps.endpoint : await detectDesktop(deps)
  if (!endpoint)
    return { ok: false, error: "the Cognia desktop app is not running (best-of-N runs there)" }
  const doFetch = deps.fetch ?? fetch
  try {
    const res = await doFetch(`${endpoint.baseUrl}${BEST_OF_N_PATH}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEV_TOKEN_HEADER]: endpoint.devToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(
        action === "select" || action === "publish" ? DECISION_TIMEOUT_MS : REQUEST_TIMEOUT_MS
      ),
    })
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      error?: string
      result?: BridgeResult
    } | null
    if (!res.ok || !body?.ok || !body.result)
      return { ok: false, error: body?.error ?? `desktop bridge answered ${res.status}` }
    return body.result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function cost(value: number | null) {
  return value == null ? "unknown" : `$${value.toFixed(4)}`
}

export function formatRun(run: CliRun): string {
  const lines = [
    `${run.groupId}  ${run.phase}  base ${run.baseSha.slice(0, 12)}  → ${run.targetRef}`,
    ...run.candidates.map(
      (candidate) =>
        `  ${candidate.index}. ${candidate.status.padEnd(16)} ${candidate.runtime}:${candidate.agent}` +
        `${candidate.model ? ` (${candidate.model})` : ""}  head ${candidate.headSha?.slice(0, 12) ?? "-"}` +
        `  ${candidate.hasChanges ? "changes" : "no changes"}  cost ${cost(candidate.costUsd)}` +
        (candidate.candidateId === run.selectedCandidateId ? "  [selected]" : "") +
        (candidate.error ? `\n     ${candidate.error}` : "")
    ),
  ]
  if (run.error) lines.push(`  error: ${run.error}`)
  if (run.archiveStatus && run.archiveStatus !== "pending")
    lines.push(`  archive: ${run.archiveStatus}`)
  return lines.join("\n") + "\n"
}

/** Why a person cannot be asked here, or null when they can. */
function interactiveRefusal(action: string, args: ParsedArgs, deps: BestOfNCommandDeps) {
  const env = deps.env ?? process.env
  const isTty = deps.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
  if (boolFlag(args, "yes"))
    return `${action} cannot be pre-approved with --yes; a person chooses the winner`
  if (env.CI) return `${action} is refused in CI and other unattended runs`
  if (!isTty()) return `${action} requires an interactive terminal`
  return null
}

export async function bestOfNCommand(
  args: ParsedArgs,
  deps: BestOfNCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const action = args.subcommand as Action | undefined
  if (args.help) {
    out.write(BEST_OF_N_USAGE + "\n")
    return 0
  }
  if (!action || !ACTIONS.includes(action)) {
    out.error(BEST_OF_N_USAGE)
    return 2
  }
  const json = boolFlag(args, "json")
  const fail = (message: string, code = 1) => {
    out.error(message)
    return code
  }
  const print = (result: BridgeResult) => {
    if (json) out.json(result)
    else if (result.runs)
      out.write(result.runs.length ? result.runs.map(formatRun).join("") : "No best-of-N runs.\n")
    else if (result.run) out.write(formatRun(result.run))
  }

  if (action === "list") {
    const result = await call("list", {}, deps)
    if (!result.ok) return fail(result.error ?? "list failed")
    print(result)
    return 0
  }

  if (action === "start") {
    const sessionId = stringFlag(args, "session")
    const prompt = args.positionals.join(" ").trim()
    const agents = stringFlag(args, "agents")
      ?.split(",")
      .map((item) => item.trim())
    const n = numberFlag(args, "n")
    const target = stringFlag(args, "target")
    const existingBranch = stringFlag(args, "existing-branch")
    if (!sessionId || !prompt) return fail(BEST_OF_N_USAGE, 2)
    if (agents?.some((item) => !item)) return fail("--agents has an empty entry", 2)
    if (n !== undefined && ![2, 3, 4].includes(n)) return fail("--n must be 2, 3 or 4", 2)
    if (agents && n !== undefined && agents.length !== n)
      return fail("--agents needs exactly one entry per attempt", 2)
    if (target && existingBranch) return fail("use either --target or --existing-branch", 2)
    const result = await call(
      "start",
      {
        sessionId,
        prompt,
        ...(n !== undefined ? { n } : {}),
        ...(agents ? { agents } : {}),
        ...(target ? { targetRef: target } : {}),
        ...(existingBranch ? { existingBranch } : {}),
      },
      deps
    )
    if (!result.ok) return fail(result.error ?? "start failed")
    print(result)
    return 0
  }

  const groupId = args.positionals[0]
  if (!groupId) return fail(BEST_OF_N_USAGE, 2)

  if (action === "status" || action === "cancel" || action === "archive") {
    const result = await call(action, { groupId }, deps)
    if (!result.ok) return fail(result.error ?? `${action} failed`)
    print(result)
    if (result.archiveError) out.error(`cleanup incomplete: ${result.archiveError}`)
    return 0
  }

  // select | publish: a person, on this terminal, then the desktop's approval.
  const candidate = action === "select" ? args.positionals[1] : undefined
  if (action === "select" && !candidate) return fail(BEST_OF_N_USAGE, 2)
  const refusal = interactiveRefusal(action, args, deps)
  if (refusal) return fail(refusal, 3)
  const current = await call("status", { groupId }, deps)
  if (!current.ok || !current.run) return fail(current.error ?? "status failed")
  out.write(formatRun(current.run))
  const ask = deps.ask ?? defaultAsk
  const question =
    action === "select"
      ? `Select candidate ${candidate} as the winner and stop the others? Type "yes" to confirm: `
      : `Publish the selected candidate to ${current.run.targetRef} (local only, never pushed)? Type "yes" to confirm: `
  const answer = await ask(question)
  if (answer?.trim().toLowerCase() !== "yes") return fail(`${action} not confirmed`, 3)
  out.write("Confirm on the desktop as well; checks run on the exact selected head.\n")
  const result = await call(
    action,
    { groupId, confirmedOnTty: true, ...(candidate ? { candidate } : {}) },
    deps
  )
  if (!result.ok) return fail(result.error ?? `${action} failed`)
  print(result)
  if (!json && result.checks) {
    for (const check of result.checks)
      out.write(`  check ${check.profileId}: ${check.outcome} at ${check.headSha.slice(0, 12)}\n`)
    const missing = (result.requiredChecks ?? []).filter(
      (id) => !result.checks!.some((check) => check.profileId === id)
    )
    if (missing.length) out.write(`  not run: ${missing.join(", ")}\n`)
  }
  if (result.releaseError) out.error(`integration release failed: ${result.releaseError}`)
  if (result.archiveError) out.error(`cleanup incomplete: ${result.archiveError}`)
  if (result.outcome && result.outcome.kind !== "published") {
    if (!json)
      out.error(
        `publish ${result.outcome.kind}${result.outcome.reason ? `: ${result.outcome.reason}` : ""}` +
          (result.outcome.message ? ` (${result.outcome.message})` : "")
      )
    return 1
  }
  return 0
}
