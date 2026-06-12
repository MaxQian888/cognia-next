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
