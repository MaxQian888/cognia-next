/**
 * `/plan` controller — browse and re-open saved plans (the markdown OpenCode
 * calls `.opencode/plans/*.md`; here `~/.cognia/plans/*.md`). `list` opens a
 * select overlay of saved plans newest-first; picking one chains to `show`,
 * which opens the plan in the scrollable document pager. The bare `/plan` (no
 * args) is handled by the pure command handler from in-memory `lastPlan`; this
 * controller covers the fs-backed cross-session views.
 *
 * fs-injected: the plan store's reader is passed through so routing unit-tests
 * without disk.
 */
import { deletePlan, listPlans, loadPlan, type PlanStoreDeps } from "./plan-store"
import { openDocument } from "./shared"
import { planDiffText, planTitle } from "./plan"
import { exploreAgent, planAgent } from "../../agent/builtin-agents"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import type { TuiAction } from "../state/types"

export interface PlanDeps {
  dispatch: (action: TuiAction) => void
  /** Config home (`~/.cognia`) where plans are stored. */
  home: string
  /** Injected plan-store fs hooks (tests pass an in-memory double). */
  store?: PlanStoreDeps
}

/** `/plan list` — a newest-first select list of saved plans. */
export function planList(deps: PlanDeps): void {
  const plans = listPlans(deps.home, deps.store)
  if (plans.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No saved plans yet. Switch to plan mode (Shift+Tab) and ask for a plan.",
    })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Saved plans",
      items: plans.map((p) => ({ id: p.id, label: p.title })),
      index: 0,
      onSelectCommand: "plan show",
    },
  })
}

/** `/plan show <id>` — open a saved plan in the document pager. */
export function planShow(id: string, deps: PlanDeps): void {
  const key = id.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plan show <id>" })
    return
  }
  const raw = loadPlan(deps.home, key, deps.store)
  if (raw == null) {
    deps.dispatch({ type: "NOTICE", message: `Plan ${key} not found.` })
    return
  }
  openDocument(deps.dispatch, { title: planTitle(raw), body: raw, format: "markdown" })
}

/** `/plan diff [<a> <b>]` — show a line-level diff between two saved plans in the
 * document pager (as a coloured ```diff block). With no args it diffs the two
 * most recent plans (previous → newest); with two ids it diffs those. */
export function planDiff(arg: string, deps: PlanDeps): void {
  const ids = arg.trim().split(/\s+/).filter(Boolean)
  let fromId: string
  let toId: string
  if (ids.length === 0) {
    const recent = listPlans(deps.home, deps.store)
    if (recent.length < 2) {
      deps.dispatch({
        type: "NOTICE",
        message: "Need at least two saved plans to diff (try /plan list).",
      })
      return
    }
    // listPlans is newest-first; diff previous → newest so `+` reads as "new".
    toId = recent[0].id
    fromId = recent[1].id
  } else if (ids.length === 2) {
    fromId = ids[0]
    toId = ids[1]
  } else {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plan diff [<from-id> <to-id>]" })
    return
  }
  const from = loadPlan(deps.home, fromId, deps.store)
  const to = loadPlan(deps.home, toId, deps.store)
  if (from == null || to == null) {
    const missing = from == null ? fromId : toId
    deps.dispatch({ type: "NOTICE", message: `Plan ${missing} not found.` })
    return
  }
  const body = `Diff ${fromId} → ${toId}\n\n\`\`\`diff\n${planDiffText(from, to)}\n\`\`\``
  openDocument(deps.dispatch, { title: `Plan diff: ${toId}`, body, format: "markdown" })
}

/** The read-only subagent dispatch seam (built from `buildAgentsRunDispatch`) —
 * runs one subagent over the live sidecar and resolves its reply text. */
type DispatchAgentSeam = (
  def: PluginSubagentDef,
  prompt: string,
  opts: { cwd?: string; abortSignal?: AbortSignal }
) => Promise<{ text: string }>

export interface PlanExploreDeps {
  dispatch: (action: TuiAction) => void
  /** Runs the built-in read-only `Explore` / `Plan` subagents over the sidecar. */
  dispatchAgent: DispatchAgentSeam
  /** Abort signal for the command (Esc interrupts between phases). */
  signal?: AbortSignal
}

/**
 * `/plan explore <task>` — the deterministic explore→plan pipeline (Claude Code
 * parity, on demand). Phase 1 dispatches the read-only built-in `Explore` agent
 * to survey the codebase; phase 2 dispatches the read-only `Plan` agent with the
 * task + exploration digest to design the approach. The Plan agent's markdown is
 * committed as the plan (COMMIT_PLAN), so it flows into the SAME approval overlay
 * as a model-driven ExitPlanMode. Both subagents stream into the live-output
 * store, so their progress is watchable via `/agents`.
 */
export async function planExplore(task: string, deps: PlanExploreDeps): Promise<void> {
  const t = task.trim()
  if (!t) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plan explore <task to plan>" })
    return
  }
  try {
    deps.dispatch({ type: "NOTICE", message: `Exploring the codebase for: ${t}` })
    const digest = await deps.dispatchAgent(
      exploreAgent().def,
      `Explore this codebase to inform an implementation plan for the task below. Report where the relevant code lives (with path:line references) and how the pieces connect.\n\nTask:\n${t}`,
      {}
    )
    if (deps.signal?.aborted) return
    deps.dispatch({ type: "NOTICE", message: "Designing the plan from the exploration…" })
    const plan = await deps.dispatchAgent(
      planAgent().def,
      `Design a concrete implementation plan for the task below, grounded in the exploration findings. Return the plan as markdown: an ordered list of steps (each naming the file(s) to change and existing utilities to reuse), the critical files, the trade-offs, and how to verify.\n\nTask:\n${t}\n\n--- Exploration findings ---\n${digest.text}`,
      {}
    )
    if (deps.signal?.aborted) return
    const raw = plan.text.trim()
    if (!raw) {
      deps.dispatch({
        type: "NOTICE",
        message: "The Plan agent returned no plan — try again or refine the task.",
      })
      return
    }
    deps.dispatch({ type: "COMMIT_PLAN", raw })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plan exploration failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/** `/plan delete <id>` — remove a saved plan, then re-open the (now shorter)
 * list so the user can keep pruning; falls back to a notice when the list is
 * empty or the id was unknown. */
export function planDelete(id: string, deps: PlanDeps): void {
  const key = id.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /plan delete <id>" })
    return
  }
  const removed = deletePlan(deps.home, key, deps.store)
  if (!removed) {
    deps.dispatch({ type: "NOTICE", message: `Plan ${key} not found.` })
    return
  }
  const remaining = listPlans(deps.home, deps.store)
  if (remaining.length === 0) {
    deps.dispatch({ type: "NOTICE", message: `Deleted plan ${key}. No saved plans left.` })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Deleted plan ${key}.` })
  planList(deps)
}
