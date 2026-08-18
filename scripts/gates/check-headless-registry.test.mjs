import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

import {
  EFFECT_PATTERN,
  MIN_REASON_LENGTH,
  calledInBrain,
  effectSymbols,
  moduleImports,
  reachableFrom,
  readExclusions,
  reconcile,
} from "./check-headless-registry.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("EFFECT_PATTERN", () => {
  it("matches effect-shaped names", () => {
    for (const n of [
      "installIssueRunBridge",
      "startUsageScheduler",
      "registerLocalIssueSource",
      "syncTerminalHostProfiles",
      "seedBuiltinIssueLabels",
      "attachManagedIdeBroker",
    ]) {
      assert.equal(EFFECT_PATTERN.test(n), true, n)
    }
  })

  it("does not match bare verbs or unrelated names", () => {
    for (const n of ["install", "start", "isTauri", "useEffect", "cn", "startled"]) {
      assert.equal(EFFECT_PATTERN.test(n), false, n)
    }
  })
})

describe("effectSymbols", () => {
  it("finds effects imported from @/lib and actually invoked", () => {
    const src = `
      import { installFoo } from "@/lib/foo"
      export function Init() { useEffect(() => installFoo(), []) }
    `
    assert.deepEqual(effectSymbols(src), ["installFoo"])
  })

  it("ignores type-only imports", () => {
    const src = `
      import type { InstallFooOptions } from "@/lib/foo"
      const x: InstallFooOptions = {}
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("ignores inline type specifiers inside a value import", () => {
    const src = `
      import { installFoo, type StartBarOptions } from "@/lib/foo"
      installFoo()
    `
    assert.deepEqual(effectSymbols(src), ["installFoo"])
  })

  it("ignores an effect that is imported but never invoked", () => {
    const src = `
      import { installFoo } from "@/lib/foo"
      export const handler = installFoo
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("resolves renamed imports to the local binding", () => {
    const src = `
      import { installFoo as installRenamed } from "@/lib/foo"
      installRenamed()
    `
    assert.deepEqual(effectSymbols(src), ["installRenamed"])
  })

  it("ignores effects imported from outside @/lib", () => {
    const src = `
      import { installFoo } from "@/components/foo"
      installFoo()
    `
    assert.deepEqual(effectSymbols(src), [])
  })
})

describe("calledInBrain", () => {
  it("is true when a reachable module calls the symbol", () => {
    const corpus = new Map([["/repo/lib/headless/runtimes/a.ts", "installFoo({ x: 1 })"]])
    assert.equal(calledInBrain("installFoo", corpus), true)
  })

  it("is false when the only occurrence is the export declaration", () => {
    // The regression this gate exists for: `lib/agent/plan/notify.ts` is
    // reachable from the brain for its other exports, but nothing calls
    // installPlanNotificationActions there.
    const corpus = new Map([
      [
        "/repo/lib/agent/plan/notify.ts",
        "export function installPlanNotificationActions() { return () => {} }",
      ],
    ])
    assert.equal(calledInBrain("installPlanNotificationActions", corpus), false)
  })

  it("is true when the defining module also calls it", () => {
    const corpus = new Map([
      [
        "/repo/lib/foo.ts",
        "export function installFoo() {}\nexport function boot() { installFoo() }",
      ],
    ])
    assert.equal(calledInBrain("installFoo", corpus), true)
  })

  it("is false when nothing reachable mentions it", () => {
    const corpus = new Map([["/repo/lib/headless/runtimes/a.ts", "installBar()"]])
    assert.equal(calledInBrain("installFoo", corpus), false)
  })
})

describe("moduleImports", () => {
  // Resolution hits the real filesystem, so the fixture names real repo
  // modules. `lib/headless/registry.ts` and `lib/headless/types.ts` are the
  // registry's own two halves and are as stable as this gate itself.
  const entry = join(REPO_ROOT, "lib/headless/entry-fixture.ts")
  const read = () => `
    import { registerHeadlessRuntime } from "@/lib/headless/registry"
    const m = await import("@/lib/headless/bootstrap")
    export * from "./types"
    import x from "some-npm-package"
    import y from "node:path"
  `

  it("follows static, dynamic and relative specifiers", () => {
    const found = moduleImports(entry, read).map((f) => relative(REPO_ROOT, f))
    assert.ok(found.includes("lib/headless/registry.ts"), "static @/ import")
    assert.ok(found.includes("lib/headless/bootstrap.ts"), "dynamic import()")
    assert.ok(found.includes("lib/headless/types.ts"), "relative re-export")
  })

  it("skips bare package and node: specifiers", () => {
    const found = moduleImports(entry, read).map((f) => relative(REPO_ROOT, f))
    assert.equal(found.length, 3)
    assert.ok(!found.some((f) => f.includes("some-npm-package")))
    assert.ok(!found.some((f) => f.includes("node:")))
  })

  it("returns an empty list when the file cannot be read", () => {
    assert.deepEqual(
      moduleImports(entry, () => {
        throw new Error("ENOENT")
      }),
      []
    )
  })
})

describe("reachableFrom", () => {
  it("terminates on an import cycle", () => {
    // A real cycle in this repo would otherwise hang the gate.
    const graph = { "/a.ts": "/b.ts", "/b.ts": "/a.ts" }
    const read = (f) => `from "${graph[f]}"`
    assert.doesNotThrow(() => reachableFrom(["/a.ts"], read))
  })
})

describe("reconcile", () => {
  const findings = [{ file: "a.tsx", symbols: ["installOne", "installTwo"] }]

  it("excuses only the named symbols, leaving the rest as violations", () => {
    const { violations } = reconcile(findings, {
      "a.tsx": { symbols: ["installTwo"], reason: "x".repeat(MIN_REASON_LENGTH) },
    })
    // The issue-tracker shape: one renderer-bound effect excused, the rest of
    // the file still gated.
    assert.deepEqual(violations, [{ file: "a.tsx", symbols: ["installOne"] }])
  })

  it("reports no violation when every dormant symbol is excused", () => {
    const { violations } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne", "installTwo"], reason: "x".repeat(MIN_REASON_LENGTH) },
    })
    assert.deepEqual(violations, [])
  })

  it("flags a row whose file is no longer dormant at all", () => {
    const { stale } = reconcile([], {
      "gone.tsx": { symbols: ["installX"], reason: "y".repeat(30) },
    })
    assert.deepEqual(stale, [{ file: "gone.tsx", symbols: ["installX"] }])
  })

  it("flags an individual symbol that got wired while its siblings did not", () => {
    const { stale } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne", "installWired"], reason: "y".repeat(30) },
    })
    assert.deepEqual(stale, [{ file: "a.tsx", symbols: ["installWired"] }])
  })

  it("flags short and missing reasons", () => {
    const { unreasoned } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne"], reason: "too short" },
      "b.tsx": { symbols: ["installX"] },
    })
    assert.deepEqual(unreasoned.sort(), ["a.tsx", "b.tsx"])
  })

  it("rejects a file-level exclusion that names no symbols", () => {
    const { symbolless } = reconcile(findings, {
      "a.tsx": { reason: "z".repeat(30) },
      "b.tsx": { symbols: [], reason: "z".repeat(30) },
    })
    assert.deepEqual(symbolless.sort(), ["a.tsx", "b.tsx"])
  })
})

describe("the shipped exclusions ledger", () => {
  const ledger = readExclusions()

  it("gives every exclusion a substantive reason", () => {
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.ok(
        entry.reason && entry.reason.trim().length >= MIN_REASON_LENGTH,
        `${file} needs a reason of at least ${MIN_REASON_LENGTH} characters`
      )
    }
  })

  it("names explicit symbols on every row", () => {
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.ok(
        Array.isArray(entry.symbols) && entry.symbols.length > 0,
        `${file} must name the symbols it excuses, not the whole file`
      )
    }
  })

  it("never excuses an effect as merely unported", () => {
    // The ledger's own rule: unported work is debt for the registry, not a
    // decision for the ledger. Catching the phrasing keeps the two apart.
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.doesNotMatch(
        entry.reason,
        /\b(not (yet )?ported|todo|later|for now|temporarily)\b/i,
        `${file} records debt, not a decision`
      )
    }
  })
})
