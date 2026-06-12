/**
 * @jest-environment node
 */
import path from "node:path"

import { planList, planShow, planDelete, planDiff } from "./plan-controller"
import { plansDir, type PlanStoreDeps } from "./plan-store"
import type { TuiAction } from "../state/types"

const HOME = "/home/.cognia"

function harness(files: Record<string, string> = {}, mtimes: Record<string, number> = {}) {
  const actions: TuiAction[] = []
  const dispatch = (a: TuiAction) => {
    actions.push(a)
  }
  const map = new Map(Object.entries(files))
  const store: PlanStoreDeps = {
    readDir: (dir) =>
      [...map.keys()].filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    readFile: (abs) => map.get(abs) ?? null,
    mtime: (abs) => mtimes[abs] ?? 0,
    unlink: (abs) => map.delete(abs),
  }
  return { actions, dispatch, store }
}

describe("planList", () => {
  it("notices when no plans are saved", () => {
    const { actions, dispatch } = harness()
    planList({ dispatch, home: HOME, store: { readDir: () => [] } })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
    expect((actions[0] as { message: string }).message).toContain("No saved plans")
  })

  it("opens a newest-first select list chaining to `plan show`", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness(
      {
        [path.join(dir, "a-plan-1.md")]: "# Older",
        [path.join(dir, "b-plan-2.md")]: "# Newer",
      },
      { [path.join(dir, "a-plan-1.md")]: 1, [path.join(dir, "b-plan-2.md")]: 2 }
    )
    planList({ dispatch, home: HOME, store })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "select", onSelectCommand: "plan show", title: "Saved plans" },
    })
    const overlay = (actions[0] as { overlay: { items: { id: string; label: string }[] } }).overlay
    expect(overlay.items.map((i) => i.id)).toEqual(["b-plan-2", "a-plan-1"])
    expect(overlay.items[0].label).toBe("Newer")
  })
})

describe("planShow", () => {
  it("rejects an empty id with usage", () => {
    const { actions, dispatch } = harness()
    planShow("  ", { dispatch, home: HOME })
    expect((actions[0] as { message: string }).message).toContain("Usage: /plan show")
  })

  it("notices a missing plan", () => {
    const { actions, dispatch } = harness()
    planShow("nope", { dispatch, home: HOME, store: { readFile: () => null } })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })

  it("opens a found plan in the document pager", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness({
      [path.join(dir, "s-plan-1.md")]: "# My plan\nbody",
    })
    planShow("s-plan-1", { dispatch, home: HOME, store })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "My plan", body: "# My plan\nbody" },
    })
  })
})

describe("planDiff", () => {
  it("notices when fewer than two plans are saved", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness({ [path.join(dir, "a-plan-1.md")]: "# Solo" })
    planDiff("", { dispatch, home: HOME, store })
    expect((actions[0] as { message: string }).message).toContain("at least two saved plans")
  })

  it("diffs the latest two plans (previous → newest) as a ```diff document", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness(
      {
        [path.join(dir, "a-plan-1.md")]: "# Plan\n- a",
        [path.join(dir, "b-plan-2.md")]: "# Plan\n- b",
      },
      { [path.join(dir, "a-plan-1.md")]: 1, [path.join(dir, "b-plan-2.md")]: 2 }
    )
    planDiff("", { dispatch, home: HOME, store })
    const overlay = (actions[0] as { overlay: { kind: string; body: string; format: string } })
      .overlay
    expect(overlay).toMatchObject({ kind: "document", format: "markdown" })
    expect(overlay.body).toContain("Diff a-plan-1 → b-plan-2")
    expect(overlay.body).toContain("```diff")
    expect(overlay.body).toContain("- - a")
    expect(overlay.body).toContain("+ - b")
  })

  it("diffs two explicit ids", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness({
      [path.join(dir, "x.md")]: "one",
      [path.join(dir, "y.md")]: "two",
    })
    planDiff("x y", { dispatch, home: HOME, store })
    const overlay = (actions[0] as { overlay: { body: string } }).overlay
    expect(overlay.body).toContain("Diff x → y")
  })

  it("notices a missing id", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness({ [path.join(dir, "x.md")]: "one" })
    planDiff("x nope", { dispatch, home: HOME, store })
    expect((actions[0] as { message: string }).message).toContain("nope not found")
  })

  it("rejects a single-id invocation with usage", () => {
    const { actions, dispatch } = harness()
    planDiff("only", { dispatch, home: HOME })
    expect((actions[0] as { message: string }).message).toContain("Usage: /plan diff")
  })
})

describe("planDelete", () => {
  it("rejects an empty id with usage", () => {
    const { actions, dispatch } = harness()
    planDelete("  ", { dispatch, home: HOME })
    expect((actions[0] as { message: string }).message).toContain("Usage: /plan delete")
  })

  it("notices a missing plan", () => {
    const { actions, dispatch } = harness()
    planDelete("nope", { dispatch, home: HOME, store: { unlink: () => false } })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })

  it("deletes the only plan and notices an empty store (no list re-open)", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness({ [path.join(dir, "s-plan-1.md")]: "# Solo" })
    planDelete("s-plan-1", { dispatch, home: HOME, store })
    expect((actions[0] as { message: string }).message).toContain("No saved plans left")
    // No follow-up OVERLAY_OPEN when nothing remains.
    expect(actions.some((a) => a.type === "OVERLAY_OPEN")).toBe(false)
  })

  it("deletes one plan then re-opens the list of the rest", () => {
    const dir = plansDir(HOME)
    const { actions, dispatch, store } = harness(
      {
        [path.join(dir, "a-plan-1.md")]: "# Keep",
        [path.join(dir, "b-plan-2.md")]: "# Drop",
      },
      { [path.join(dir, "a-plan-1.md")]: 1, [path.join(dir, "b-plan-2.md")]: 2 }
    )
    planDelete("b-plan-2", { dispatch, home: HOME, store })
    expect((actions[0] as { message: string }).message).toContain("Deleted plan b-plan-2")
    // Re-opens the list with only the surviving plan.
    expect(actions[1]).toMatchObject({ type: "OVERLAY_OPEN", overlay: { kind: "select" } })
    const overlay = (actions[1] as { overlay: { items: { id: string }[] } }).overlay
    expect(overlay.items.map((i) => i.id)).toEqual(["a-plan-1"])
  })
})
