import {
  buildExpressPlan,
  isPlanRunnable,
  selectedActions,
  withSelection,
  type BuildExpressPlanInput,
  type ExpressPlanItem,
} from "./express-plan"
import type { ScanResult } from "./scan"

const EMPTY_SCAN: ScanResult = { runtimes: [], migratable: [], capabilities: ["web"] }

const build = (over: Partial<BuildExpressPlanInput> = {}) =>
  buildExpressPlan({
    shell: "tauri",
    scan: EMPTY_SCAN,
    historyTotal: 0,
    modelAccess: true,
    ...over,
  })

const kinds = (items: readonly ExpressPlanItem[]) => items.map((item) => item.kind)

/** A desktop with Claude Code signed in and Codex installed but not. */
const RICH_SCAN: ScanResult = {
  runtimes: [
    { id: "claude-code", label: "Claude Code", authenticated: true },
    { id: "codex", label: "Codex", authenticated: false },
  ],
  migratable: [
    { vendor: "claude-code", installed: true, configPath: "~/.claude" },
    { vendor: "codex", installed: true, configPath: "~/.codex" },
  ],
  capabilities: ["fs", "ocr", "web"],
}

describe("buildExpressPlan", () => {
  it("always ends with what the first task will be able to do", () => {
    // The one line every shell gets, because every shell can do *something* —
    // it is what stops the screen from ever being empty.
    expect(kinds(build()).at(-1)).toBe("capabilities")
    expect(build().at(-1)?.capabilities).toEqual(["web"])
  })

  it("offers one migration line per installed vendor", () => {
    const items = build({ scan: RICH_SCAN })
    const migrations = items.filter((item) => item.kind === "migrate-config")
    expect(migrations.map((item) => item.vendor)).toEqual(["claude-code", "codex"])
  })

  it("labels a migration line with the vendor's display name, not its id", () => {
    // A line reading "Bring over your claude-code setup" prints an internal
    // slug at someone who has only ever seen the words "Claude Code".
    const migration = build({ scan: RICH_SCAN }).find((item) => item.kind === "migrate-config")
    expect(migration?.label).toBe("Claude Code")
  })

  it("falls back to the vendor id when the scan's two halves disagree", () => {
    const orphaned: ScanResult = { ...EMPTY_SCAN, migratable: RICH_SCAN.migratable }
    const migration = build({ scan: orphaned }).find((item) => item.kind === "migrate-config")
    expect(migration?.label).toBe("claude-code")
  })

  it("skips a vendor the probe found but did not consider installed", () => {
    const scan: ScanResult = {
      ...EMPTY_SCAN,
      migratable: [{ vendor: "codex", installed: false }],
    }
    expect(kinds(build({ scan }))).not.toContain("migrate-config")
  })

  it("offers the history line only when there is history", () => {
    expect(kinds(build({ historyTotal: 0 }))).not.toContain("import-history")
    const withHistory = build({ historyTotal: 128 }).find((item) => item.kind === "import-history")
    expect(withHistory?.count).toBe(128)
  })

  it("says out loud that a signed-in CLI is how the first task reaches a model", () => {
    // It is why the step-by-step path can skip its sign-in step entirely, so
    // the recommended path has to name it — otherwise a user with a working
    // Claude Code sees a plan that never mentions how anything will run.
    const runtime = build({ scan: RICH_SCAN, modelAccess: true }).find(
      (item) => item.kind === "use-runtime"
    )
    expect(runtime?.label).toBe("Claude Code")
    expect(runtime?.required).toBe(true)
  })

  it("ignores an installed-but-unauthenticated runtime as a model source", () => {
    const scan: ScanResult = {
      ...EMPTY_SCAN,
      runtimes: [{ id: "codex", label: "Codex", authenticated: false }],
    }
    expect(kinds(build({ scan, modelAccess: false }))).toContain("sign-in")
    expect(kinds(build({ scan, modelAccess: false }))).not.toContain("use-runtime")
  })

  it("collapses to two lines on a machine with nothing on it", () => {
    // The intended shape, not a degenerate one: the screen is an adaptive list,
    // not a fixed form with empty rows.
    expect(kinds(build({ modelAccess: false }))).toEqual(["sign-in", "capabilities"])
  })

  it("does not flash a sign-in line while the probe is unsettled", () => {
    expect(kinds(build({ modelAccess: null }))).not.toContain("sign-in")
  })

  it("gives a paired phone pairing instead of any credential line", () => {
    // Its compute and its credentials both live on the desktop it pairs with,
    // so asking it to sign in would configure the wrong device.
    const items = kinds(build({ shell: "mobile-paired", scan: RICH_SCAN, modelAccess: false }))
    expect(items).toContain("pair")
    expect(items).not.toContain("sign-in")
    expect(items).not.toContain("use-runtime")
  })

  it("still folds a browser's two screens into one", () => {
    // No local scan, but the sign-in line plus the capability line is still a
    // screen fewer than sign-in-then-first-run.
    expect(kinds(build({ shell: "web", modelAccess: false }))).toEqual(["sign-in", "capabilities"])
  })

  it("orders config before history, and model access after both", () => {
    // The migration writes the skills a transcript may reference, and the
    // credential line is the only one that can block on a browser round trip.
    expect(kinds(build({ scan: RICH_SCAN, historyTotal: 5 }))).toEqual([
      "migrate-config",
      "migrate-config",
      "import-history",
      "use-runtime",
      "capabilities",
    ])
  })

  it("pre-checks everything — dropping a line is a deliberate act", () => {
    expect(build({ scan: RICH_SCAN, historyTotal: 5 }).every((item) => item.selected)).toBe(true)
  })

  it("gives every line a unique id, since they key React rows and scene nodes", () => {
    const ids = build({ scan: RICH_SCAN, historyTotal: 5 }).map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("withSelection", () => {
  const items = build({ scan: RICH_SCAN, historyTotal: 5 })

  it("folds the user's checkboxes back into a freshly built plan", () => {
    const kept = items.filter((item) => item.id !== "history").map((item) => item.id)
    const next = withSelection(items, kept)
    expect(next.find((item) => item.id === "history")?.selected).toBe(false)
  })

  it("keeps required lines selected however the caller asks", () => {
    // They are statements of fact; there is nothing to deselect.
    const next = withSelection(items, [])
    expect(next.filter((item) => item.required).every((item) => item.selected)).toBe(true)
  })

  it("drops an id it does not recognise rather than resurrecting it", () => {
    const next = withSelection(items, ["migrate-claude-code", "ghost"])
    expect(next.map((item) => item.id)).not.toContain("ghost")
  })

  it("does not mutate the plan it was given", () => {
    withSelection(items, [])
    expect(items.every((item) => item.selected)).toBe(true)
  })
})

describe("selectedActions", () => {
  it("returns only the lines that actually write something", () => {
    const items = withSelection(build({ scan: RICH_SCAN, historyTotal: 5 }), [
      "migrate-claude-code",
      "history",
    ])
    expect(selectedActions(items).map((item) => item.id)).toEqual([
      "migrate-claude-code",
      "history",
    ])
  })

  it("never returns a statement of fact — there is nothing to run", () => {
    const items = build({ scan: RICH_SCAN, modelAccess: true })
    expect(selectedActions(items).map((item) => item.kind)).not.toContain("use-runtime")
    expect(selectedActions(items).map((item) => item.kind)).not.toContain("capabilities")
  })

  it("skips a dropped line", () => {
    const items = withSelection(build({ scan: RICH_SCAN, historyTotal: 5 }), [])
    expect(selectedActions(items)).toEqual([])
  })
})

describe("isPlanRunnable", () => {
  it("lets a plan with nothing outstanding run", () => {
    expect(isPlanRunnable({ items: build({ scan: RICH_SCAN }), modelAccess: true })).toBe(true)
  })

  it("blocks a plan whose sign-in line is unsatisfied", () => {
    // Applying it would import nothing and hand the user a first task with no
    // model behind it — the exact failure the terminal step guards against.
    const items = build({ modelAccess: false })
    expect(isPlanRunnable({ items, modelAccess: false })).toBe(false)
  })

  it("releases as soon as a credential lands on the screen itself", () => {
    const items = build({ modelAccess: false })
    expect(isPlanRunnable({ items, modelAccess: true })).toBe(true)
  })

  it("does not block on an unsettled probe", () => {
    const items = build({ modelAccess: false })
    expect(isPlanRunnable({ items, modelAccess: null })).toBe(true)
  })

  it("blocks a paired phone until it is actually paired", () => {
    const items = build({ shell: "mobile-paired", modelAccess: null })
    expect(isPlanRunnable({ items, modelAccess: null, paired: false })).toBe(false)
    expect(isPlanRunnable({ items, modelAccess: null, paired: null })).toBe(false)
    expect(isPlanRunnable({ items, modelAccess: null, paired: true })).toBe(true)
  })
})
