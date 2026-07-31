/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  deletePlan,
  latestPlan,
  listPlans,
  loadPlan,
  plansDir,
  savePlan,
  type PlanStoreDeps,
} from "./plan-store"

const HOME = "/home/.cognia"

/** An in-memory fs double for the injected deps. */
function memFs(initial: Record<string, string> = {}, mtimes: Record<string, number> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const deps: PlanStoreDeps = {
    readDir: (dir) =>
      [...files.keys()].filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    readFile: (abs) => files.get(abs) ?? null,
    writeFile: (abs, data) => {
      files.set(abs, data)
    },
    mkdir: (dir) => {
      dirs.add(dir)
    },
    mtime: (abs) => mtimes[abs] ?? 0,
    unlink: (abs) => files.delete(abs),
  }
  return { files, dirs, deps }
}

describe("savePlan", () => {
  it("creates the plans dir and writes the file, returning its path", () => {
    const { files, dirs, deps } = memFs()
    const abs = savePlan(HOME, "s-plan-1.md", "# Plan", deps)
    expect(abs).toBe(path.join(plansDir(HOME), "s-plan-1.md"))
    expect(dirs.has(plansDir(HOME))).toBe(true)
    expect(files.get(abs!)).toBe("# Plan")
  })

  it("returns null when the write throws (read-only home)", () => {
    const deps: PlanStoreDeps = {
      mkdir: () => {},
      writeFile: () => {
        throw new Error("EROFS")
      },
    }
    expect(savePlan(HOME, "s-plan-1.md", "x", deps)).toBeNull()
  })
})

describe("listPlans", () => {
  it("returns [] when the dir is absent", () => {
    expect(listPlans(HOME, { readDir: () => [] })).toEqual([])
  })

  it("lists .md plans newest-first with derived titles", () => {
    const dir = plansDir(HOME)
    const { deps } = memFs(
      {
        [path.join(dir, "a-plan-1.md")]: "# Older plan\nbody",
        [path.join(dir, "b-plan-2.md")]: "# Newer plan\nbody",
        [path.join(dir, "notes.txt")]: "ignored",
      },
      { [path.join(dir, "a-plan-1.md")]: 100, [path.join(dir, "b-plan-2.md")]: 200 }
    )
    const plans = listPlans(HOME, deps)
    expect(plans.map((p) => p.id)).toEqual(["b-plan-2", "a-plan-1"])
    expect(plans[0]).toMatchObject({ title: "Newer plan", savedAt: 200 })
  })

  it("breaks mtime ties by reverse id", () => {
    const dir = plansDir(HOME)
    const { deps } = memFs({
      [path.join(dir, "x-plan-1.md")]: "a",
      [path.join(dir, "x-plan-2.md")]: "b",
    })
    // Both mtimes default to 0 → reverse-name order puts plan-2 first.
    expect(listPlans(HOME, deps).map((p) => p.id)).toEqual(["x-plan-2", "x-plan-1"])
  })
})

describe("loadPlan", () => {
  it("loads a plan's raw markdown by id", () => {
    const dir = plansDir(HOME)
    const { deps } = memFs({ [path.join(dir, "s-plan-1.md")]: "# Hi" })
    expect(loadPlan(HOME, "s-plan-1", deps)).toBe("# Hi")
  })

  it("returns null for a missing plan", () => {
    expect(loadPlan(HOME, "nope", { readFile: () => null })).toBeNull()
  })
})

describe("deletePlan", () => {
  it("removes the plan file and reports success", () => {
    const dir = plansDir(HOME)
    const { files, deps } = memFs({ [path.join(dir, "s-plan-1.md")]: "# Hi" })
    expect(deletePlan(HOME, "s-plan-1", deps)).toBe(true)
    expect(files.has(path.join(dir, "s-plan-1.md"))).toBe(false)
  })

  it("reports false for a missing plan without throwing", () => {
    expect(deletePlan(HOME, "nope", { unlink: () => false })).toBe(false)
  })

  it("reports false (no-op) for a blank id", () => {
    const unlink = jest.fn(() => true)
    expect(deletePlan(HOME, "  ", { unlink })).toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })
})

describe("latestPlan", () => {
  it("returns the newest plan's id + raw", () => {
    const dir = plansDir(HOME)
    const { deps } = memFs(
      {
        [path.join(dir, "a-plan-1.md")]: "old",
        [path.join(dir, "b-plan-2.md")]: "new",
      },
      { [path.join(dir, "a-plan-1.md")]: 1, [path.join(dir, "b-plan-2.md")]: 2 }
    )
    expect(latestPlan(HOME, deps)).toEqual({ id: "b-plan-2", raw: "new" })
  })

  it("returns null when there are no plans", () => {
    expect(latestPlan(HOME, { readDir: () => [] })).toBeNull()
  })

  it("returns null when the newest plan vanished between list and load", () => {
    const dir = plansDir(HOME)
    const deps: PlanStoreDeps = {
      readDir: () => ["s-plan-1.md"],
      readFile: () => null, // listed but unreadable
      mtime: () => 1,
    }
    void dir
    expect(latestPlan(HOME, deps)).toBeNull()
  })
})

// Exercise the real-filesystem defaults (no injected deps) against a temp home,
// so the default reader/writer/dir/stat helpers are covered end-to-end.
describe("plan-store with the real filesystem", () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-plans-"))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it("saves, lists, loads, and finds the latest plan via real fs", () => {
    const abs = savePlan(tmpHome, "s-plan-1.md", "# Real plan\nbody")
    expect(abs).toBe(path.join(plansDir(tmpHome), "s-plan-1.md"))
    expect(fs.existsSync(abs!)).toBe(true)

    const plans = listPlans(tmpHome)
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ id: "s-plan-1", title: "Real plan" })
    expect(plans[0].savedAt).toBeGreaterThan(0)

    expect(loadPlan(tmpHome, "s-plan-1")).toBe("# Real plan\nbody")
    expect(latestPlan(tmpHome)).toEqual({ id: "s-plan-1", raw: "# Real plan\nbody" })
  })

  it("degrades to empty/null for an absent plans dir via the default readers", () => {
    expect(listPlans(tmpHome)).toEqual([])
    expect(loadPlan(tmpHome, "missing")).toBeNull()
    expect(latestPlan(tmpHome)).toBeNull()
  })

  it("deletes a saved plan via the default unlink and no-ops on a missing one", () => {
    savePlan(tmpHome, "s-plan-1.md", "# Real plan")
    expect(deletePlan(tmpHome, "s-plan-1")).toBe(true)
    expect(loadPlan(tmpHome, "s-plan-1")).toBeNull()
    // A second delete (file already gone) fails cleanly rather than throwing.
    expect(deletePlan(tmpHome, "s-plan-1")).toBe(false)
  })
})
