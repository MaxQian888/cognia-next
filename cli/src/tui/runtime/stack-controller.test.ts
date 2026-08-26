/**
 * @jest-environment node
 */
import {
  chainContaining,
  chainsFrom,
  isValidBranchName,
  parentOf,
  readParents,
  runStack,
  type StackDeps,
} from "./stack-controller"
import type { ExecResult } from "../../agent/run-git"
import type { TuiAction } from "../state/types"

const OK: ExecResult = { stdout: "", stderr: "", code: 0 }

interface GitState {
  /** `[child, parent]` pairs, rendered as `git config --get-regexp` output. */
  parents?: Array<[string, string]>
  branch?: string
  /** Branch names `rev-parse --verify` should resolve. */
  existing?: string[]
  dirty?: string
  rebase?: Partial<Record<string, ExecResult>>
  push?: ExecResult
  pushHelp?: string
  config?: ExecResult
}

function makeGit(state: GitState) {
  const calls: string[][] = []
  const existing = new Set(state.existing ?? ["main", "me/api", "me/ui", "me/docs"])
  const fn = jest.fn(async (args: string[]): Promise<ExecResult> => {
    calls.push(args)
    const joined = args.join(" ")
    if (joined.startsWith("config --get-regexp")) {
      const pairs = state.parents ?? []
      if (pairs.length === 0) return { ...OK, code: 1 }
      return {
        stdout: pairs
          .map(([child, parent]) => `branch.${child}.cognia-parent ${parent}`)
          .join("\n"),
        stderr: "",
        code: 0,
      }
    }
    if (joined.startsWith("config --get branch.")) {
      const key = args[2].slice("branch.".length, -".cognia-parent".length)
      const found = (state.parents ?? []).find(([child]) => child === key)
      return found ? { stdout: `${found[1]}\n`, stderr: "", code: 0 } : { ...OK, code: 1 }
    }
    if (joined.startsWith("config --unset")) return state.config ?? OK
    if (args[0] === "config") return state.config ?? OK
    if (joined === "rev-parse --abbrev-ref HEAD")
      return { stdout: state.branch ?? "me/ui", stderr: "", code: 0 }
    if (joined.startsWith("rev-parse --verify --quiet")) {
      const name = args[3]
      return existing.has(name)
        ? { stdout: `sha-${name}\n`, stderr: "", code: 0 }
        : { ...OK, code: 1 }
    }
    if (joined === "status --porcelain") return { stdout: state.dirty ?? "", stderr: "", code: 0 }
    if (joined.startsWith("merge-base --is-ancestor")) return OK
    if (args[0] === "rebase") return state.rebase?.[args.at(-1)!] ?? OK
    if (joined === "push -h")
      return {
        stdout: state.pushHelp ?? "--force-with-lease --force-if-includes",
        stderr: "",
        code: 0,
      }
    if (args[0] === "push") return state.push ?? OK
    if (args[0] === "checkout") return OK
    return OK
  })
  return { fn, calls }
}

function harness(over: Partial<StackDeps> & { git?: GitState } = {}) {
  const notices: string[] = []
  const { fn, calls } = makeGit(over.git ?? {})
  const deps: StackDeps = {
    dispatch: (action: TuiAction) => {
      if (action.type === "NOTICE") notices.push(action.message)
    },
    cwd: "/repo",
    runGit: (args: string[]) => fn(args),
    ...over,
  }
  return { deps, notices, calls, git: fn }
}

const CHAIN: Array<[string, string]> = [
  ["me/api", "main"],
  ["me/ui", "me/api"],
  ["me/docs", "me/ui"],
]

describe("isValidBranchName", () => {
  it("refuses anything git would read as a flag or reject as a ref", () => {
    // Every value is interpolated into an argv list, and a name starting with
    // `-` is read as a flag by whichever git command receives it.
    for (const bad of [
      "",
      "-x",
      "--force",
      "a b",
      "a..b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a/",
      "x.lock",
      "a\\b",
    ]) {
      expect(isValidBranchName(bad)).toBe(false)
    }
    for (const good of ["main", "me/feature-1", "release/2026.08", "feat_x"]) {
      expect(isValidBranchName(good)).toBe(true)
    }
  })
})

describe("readParents", () => {
  it("parses branch names that contain dots", async () => {
    // `branch.<name>.cognia-parent` split on "." loses `release/2026.08`.
    const { deps } = harness({ git: { parents: [["release/2026.08", "main"]] } })
    expect(await readParents(deps)).toEqual([["release/2026.08", "main"]])
  })

  it("treats no matching key as an empty repository of stacks", async () => {
    const { deps } = harness()
    expect(await readParents(deps)).toEqual([])
  })
})

describe("chainsFrom", () => {
  it("walks a chain bottom-first and names the trunk", () => {
    expect(chainsFrom(CHAIN)).toEqual([{ layers: ["me/api", "me/ui", "me/docs"], trunk: "main" }])
  })

  it("a branch with two children is two chains sharing a prefix", () => {
    const chains = chainsFrom([...CHAIN, ["me/alt", "me/api"]])
    expect(chains.map((chain) => chain.layers)).toEqual([
      ["me/api", "me/alt"],
      ["me/api", "me/ui", "me/docs"],
    ])
  })

  it("drops a pointer cycle rather than hanging or throwing", () => {
    // Corrupt data one `git config --unset` fixes; refusing to show any chain
    // because one is broken hides the ones that are fine.
    const chains = chainsFrom([
      ["a", "b"],
      ["b", "a"],
      ["me/api", "main"],
    ])
    expect(chains).toEqual([{ layers: ["me/api"], trunk: "main" }])
  })
})

describe("chainContaining / parentOf", () => {
  it("finds the chain a layer belongs to", () => {
    expect(chainContaining(chainsFrom(CHAIN), "me/ui")?.trunk).toBe("main")
    expect(chainContaining(chainsFrom(CHAIN), "unrelated")).toBeNull()
  })

  it("reads one branch's recorded parent", async () => {
    const { deps } = harness({ git: { parents: CHAIN } })
    expect(await parentOf(deps, "me/ui")).toBe("me/api")
    expect(await parentOf(deps, "main")).toBeNull()
  })
})

describe("/stack (list)", () => {
  it("draws each chain and marks the branch HEAD is on", async () => {
    const { deps, notices } = harness({ git: { parents: CHAIN, branch: "me/ui" } })
    await runStack(deps)
    expect(notices[0]).toContain("main")
    expect(notices[0]).toContain("me/ui ←")
    expect(notices[0]).not.toContain("me/docs ←")
  })

  it("says how to start one when there are none", async () => {
    const { deps, notices } = harness()
    await runStack(deps)
    expect(notices[0]).toMatch(/No stacks recorded/)
  })
})

describe("/stack on", () => {
  it("records the parent", async () => {
    const { deps, notices, calls } = harness({ git: { branch: "me/ui" } })
    await runStack({ ...deps, action: "on", arg: " me/api " })
    expect(calls).toContainEqual(["config", "branch.me/ui.cognia-parent", "me/api"])
    expect(notices.at(-1)).toBe("me/ui is stacked on me/api.")
  })

  it("refuses a name git would read as a flag", async () => {
    const { deps, notices, calls } = harness({ git: { branch: "me/ui" } })
    await runStack({ ...deps, action: "on", arg: "--exec=touch /tmp/x" })
    expect(notices.at(-1)).toMatch(/Not a valid branch name/)
    expect(calls.some((call) => call[0] === "config" && call.length === 3)).toBe(false)
  })

  it("refuses a parent that does not exist", async () => {
    const { deps, notices } = harness({ git: { branch: "me/ui", existing: ["main"] } })
    await runStack({ ...deps, action: "on", arg: "me/ghost" })
    expect(notices.at(-1)).toBe("No such branch: me/ghost")
  })

  it("refuses a branch stacked on itself", async () => {
    const { deps, notices } = harness({ git: { branch: "me/ui" } })
    await runStack({ ...deps, action: "on", arg: "me/ui" })
    expect(notices.at(-1)).toMatch(/cannot be stacked on itself/)
  })

  it("refuses a pointer that would close a loop", async () => {
    // Cheaper to refuse once than to drop the chain silently on every read.
    const { deps, notices, calls } = harness({
      git: { branch: "me/api", parents: CHAIN },
    })
    await runStack({ ...deps, action: "on", arg: "me/docs" })
    expect(notices.at(-1)).toMatch(/would make a loop/)
    expect(calls).not.toContainEqual(["config", "branch.me/api.cognia-parent", "me/docs"])
  })

  it("refuses on a detached HEAD", async () => {
    const { deps, notices } = harness({ git: { branch: "HEAD" } })
    await runStack({ ...deps, action: "on", arg: "main" })
    expect(notices.at(-1)).toMatch(/Detached HEAD/)
  })
})

describe("/stack off", () => {
  it("clears the pointer", async () => {
    const { deps, notices, calls } = harness({ git: { branch: "me/ui" } })
    await runStack({ ...deps, action: "off" })
    expect(calls).toContainEqual(["config", "--unset", "branch.me/ui.cognia-parent"])
    expect(notices.at(-1)).toBe("me/ui is no longer stacked.")
  })

  it("treats a missing key as already done", async () => {
    // git exits 5 for "the key was not there", which is the state asked for.
    const { deps, notices } = harness({
      git: { branch: "me/ui", config: { ...OK, code: 5 } },
    })
    await runStack({ ...deps, action: "off" })
    expect(notices.at(-1)).toBe("me/ui is no longer stacked.")
  })
})

describe("/stack check", () => {
  it("reports a healthy chain", async () => {
    const { deps, notices } = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...deps, action: "check" })
    expect(notices.at(-1)).toMatch(/every layer contains its parent/)
  })

  it("names a missing branch and a layer that is behind", async () => {
    const git: GitState = { branch: "me/ui", parents: CHAIN, existing: ["main", "me/api", "me/ui"] }
    const { deps, notices } = harness({ git })
    await runStack({ ...deps, action: "check" })
    expect(notices.at(-1)).toContain("me/docs: branch is missing")
  })

  it("says so when the branch is not stacked", async () => {
    const { deps, notices } = harness({ git: { branch: "solo" } })
    await runStack({ ...deps, action: "check" })
    expect(notices.at(-1)).toMatch(/is not stacked/)
  })
})

describe("/stack restack", () => {
  it("replays each layer onto its parent's PRE-restack tip", async () => {
    // Using the already-moved parent as the upstream replays its commits a
    // second time, turning a three-commit stack into a six-commit one.
    const { deps, calls } = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...deps, action: "restack" })
    const rebases = calls.filter((call) => call[0] === "rebase")
    expect(rebases).toEqual([
      ["rebase", "--onto", "main", "sha-main", "me/api"],
      ["rebase", "--onto", "me/api", "sha-me/api", "me/ui"],
      ["rebase", "--onto", "me/ui", "sha-me/ui", "me/docs"],
    ])
  })

  it("puts the user back on the branch they started from", async () => {
    const { deps, calls } = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...deps, action: "restack" })
    expect(calls.at(-1)).toEqual(["checkout", "me/ui"])
  })

  it("refuses a dirty working tree", async () => {
    const { deps, notices, calls } = harness({
      git: { branch: "me/ui", parents: CHAIN, dirty: " M a.ts" },
    })
    await runStack({ ...deps, action: "restack" })
    expect(notices.at(-1)).toMatch(/not clean/)
    expect(calls.some((call) => call[0] === "rebase")).toBe(false)
  })

  it("stops at the conflicting layer and says what already moved", async () => {
    const { deps, notices, calls } = harness({
      git: {
        branch: "me/ui",
        parents: CHAIN,
        rebase: { "me/ui": { stdout: "", stderr: "CONFLICT (content)", code: 1 } },
      },
    })
    await runStack({ ...deps, action: "restack" })
    expect(notices.at(-1)).toContain("Restack stopped at me/ui")
    expect(notices.at(-1)).toContain("Already moved: me/api")
    expect(notices.at(-1)).toMatch(/git rebase --continue/)
    // It must not carry on into the next layer on top of a conflicted tree.
    expect(calls.filter((call) => call[0] === "rebase")).toHaveLength(2)
  })
})

describe("/stack push", () => {
  it("pushes every layer with both leases when git has them", async () => {
    const { deps, calls, notices } = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...deps, action: "push" })
    expect(calls).toContainEqual([
      "push",
      "--force-with-lease",
      "--force-if-includes",
      "--set-upstream",
      "origin",
      "me/api",
      "me/ui",
      "me/docs",
    ])
    expect(notices.at(-1)).toBe("Pushed me/api, me/ui, me/docs to origin.")
  })

  it("says when the lease is the weaker kind", async () => {
    // `--force-with-lease` alone is defeated by a background fetch, which
    // updates the tracking ref the lease compares against.
    const { deps, calls, notices } = harness({
      git: { branch: "me/ui", parents: CHAIN, pushHelp: "--force-with-lease" },
    })
    await runStack({ ...deps, action: "push" })
    expect(calls).toContainEqual([
      "push",
      "--force-with-lease",
      "--set-upstream",
      "origin",
      "me/api",
      "me/ui",
      "me/docs",
    ])
    expect(notices.at(-1)).toMatch(/weaker kind/)
  })

  it("takes a remote and refuses one that reads as a flag", async () => {
    const { deps, calls } = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...deps, action: "push", arg: "upstream" })
    expect(calls.some((call) => call.includes("upstream"))).toBe(true)

    const second = harness({ git: { branch: "me/ui", parents: CHAIN } })
    await runStack({ ...second.deps, action: "push", arg: "--receive-pack=touch" })
    expect(second.notices.at(-1)).toMatch(/Not a valid remote name/)
    expect(second.calls.some((call) => call[0] === "push" && call.length > 2)).toBe(false)
  })

  it("surfaces a refused push", async () => {
    const { deps, notices } = harness({
      git: {
        branch: "me/ui",
        parents: CHAIN,
        push: { stdout: "", stderr: "stale info", code: 1 },
      },
    })
    await runStack({ ...deps, action: "push" })
    expect(notices.at(-1)).toBe("Push refused: stale info")
  })
})
