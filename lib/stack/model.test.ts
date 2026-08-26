import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, sep } from "node:path"

import {
  DEFAULT_BRANCH_TEMPLATE,
  baseBranches,
  renderBranchName,
  slugifyBranchSegment,
  stackTopology,
  type Stack,
} from "./model"

const STACK: Pick<Stack, "trunk" | "layers"> = {
  trunk: "main",
  layers: [
    { id: "c", branch: "me/c", title: "C", order: 2 },
    { id: "a", branch: "me/a", title: "A", order: 0 },
    { id: "b", branch: "me/b", title: "B", order: 1 },
  ],
}

describe("stackTopology", () => {
  it("makes each layer depend on the one below it", () => {
    expect(stackTopology(STACK)).toEqual([
      { id: "a", dependsOn: [], order: 0, tieBreaker: "me/a" },
      { id: "b", dependsOn: ["a"], order: 1, tieBreaker: "me/b" },
      { id: "c", dependsOn: ["b"], order: 2, tieBreaker: "me/c" },
    ])
  })
})

describe("baseBranches", () => {
  it("bases the bottom layer on the trunk and every other on the layer below", () => {
    // This map is what a pull request's base is set from, so getting it wrong
    // publishes a diff containing the layers underneath.
    expect([...baseBranches(STACK)]).toEqual([
      ["me/a", "main"],
      ["me/b", "me/a"],
      ["me/c", "me/b"],
    ])
  })

  it("handles a single-layer stack", () => {
    expect([...baseBranches({ trunk: "trunk", layers: [STACK.layers[1]!] })]).toEqual([
      ["me/a", "trunk"],
    ])
  })
})

describe("renderBranchName", () => {
  it("fills the default template", () => {
    expect(renderBranchName(DEFAULT_BRANCH_TEMPLATE, { user: "Ada", slug: "Fix the Thing" })).toBe(
      "ada/fix-the-thing"
    )
  })

  it("leaves an unknown placeholder visible rather than silently dropping it", () => {
    // A blanked segment produces a plausible name that collides with the next
    // one; a visibly wrong name gets fixed.
    expect(renderBranchName("{user}/{nope}", { user: "ada" })).toBe("ada/{nope}")
  })

  it("does not leave a leading or doubled slash when a value is absent", () => {
    // git rejects `/thing` outright, so an empty user must not produce one.
    expect(renderBranchName("{user}/{slug}", { user: "", slug: "thing" })).toBe("{user}/thing")
    expect(renderBranchName("a//{slug}", { slug: "b" })).toBe("a/b")
  })

  it("slugifies punctuation and trims to a sane length", () => {
    expect(slugifyBranchSegment("  Hello, World!! ")).toBe("hello-world")
    expect(slugifyBranchSegment("x".repeat(200))).toHaveLength(60)
    expect(slugifyBranchSegment("---")).toBe("")
  })
})

describe("commit-per-pull-request is inert, on purpose", () => {
  // Working Rule 7: intentional dormancy is documented at the type, labelled in
  // the UI, and pinned by a test. This is the third axis. Without it the note
  // in `model.ts` quietly becomes false the first time somebody half-wires the
  // model and stops.
  const ROOTS = ["app", "components", "hooks", "lib", "plugins", "stores"]
  const ENGINE = join("lib", "stack") + sep

  function walk(dir: string, onFile: (path: string) => void): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        walk(path, onFile)
        continue
      }
      if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) onFile(path)
    }
  }

  const scanned: string[] = []
  const callers: string[] = []
  for (const root of ROOTS) {
    const dir = join(process.cwd(), root)
    if (!existsSync(dir)) continue
    walk(dir, (path) => {
      const relative = path.slice(process.cwd().length + 1)
      scanned.push(relative)
      // The engine itself may name the model — `chooseMergeMethod` refuses to
      // squash it, which is the whole reason the member is declared.
      if (relative.startsWith(ENGINE)) return
      const source = readFileSync(path, "utf8")
      if (source.includes("commitPerPullRequest") || source.includes("CHANGE_ID_TRAILER")) {
        callers.push(relative)
      }
    })
  }

  it("scanned the tree it claims to have scanned", () => {
    // A sweep that walked nothing also reports no callers.
    expect(scanned.length).toBeGreaterThan(2000)
    expect(scanned).toContain(join("lib", "stack", "publish.ts"))
  })

  it("has no producer outside the engine", () => {
    expect(callers).toEqual([])
  })
})
