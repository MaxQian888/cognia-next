/**
 * @jest-environment node
 */
import {
  runPr,
  buildPrSummaryPrompt,
  parsePrDraft,
  formatPrBody,
  PR_FOOTER,
  type PrDeps,
} from "./pr-controller"
import type { ExecResult } from "../../agent/run-git"
import type { TuiAction } from "../state/types"
import type { ResolvedConfig } from "../../config/schema"

const OK: ExecResult = { stdout: "", stderr: "", code: 0 }

interface GitState {
  mainExists?: boolean
  masterExists?: boolean
  branch?: string
  commits?: string
  /** Recorded stack parent for the current branch, and whether it exists. */
  stackParent?: string
  stackParentExists?: boolean
}

function makeGit(st: GitState) {
  return jest.fn(async (args: string[]): Promise<ExecResult> => {
    const s = args.join(" ")
    if (s === "rev-parse --verify --quiet main")
      return { ...OK, code: st.mainExists === false ? 1 : 0 }
    if (s === "rev-parse --verify --quiet master")
      return { ...OK, code: st.masterExists === false ? 1 : 0 }
    if (s === "rev-parse --abbrev-ref HEAD")
      return { stdout: st.branch ?? "feature/x", stderr: "", code: 0 }
    if (s.startsWith("config --get branch."))
      return st.stackParent
        ? { stdout: `${st.stackParent}\n`, stderr: "", code: 0 }
        : { ...OK, code: 1 }
    if (st.stackParent && s === `rev-parse --verify --quiet ${st.stackParent}`)
      return { ...OK, code: st.stackParentExists === false ? 1 : 0 }
    if (args[0] === "log") return { stdout: st.commits ?? "- feat: x\n", stderr: "", code: 0 }
    if (args[0] === "diff") return { stdout: " a.ts | 2 +-\n", stderr: "", code: 0 }
    return OK
  })
}

function harness(
  over: Partial<PrDeps> & { git?: GitState; gh?: ExecResult; ghVersion?: ExecResult } = {}
) {
  const actions: TuiAction[] = []
  const git = makeGit(over.git ?? {})
  const runGh = jest.fn(async (args: string[]): Promise<ExecResult> => {
    if (args[0] === "--version") return over.ghVersion ?? { stdout: "gh 2.0", stderr: "", code: 0 }
    return over.gh ?? { stdout: "https://github.com/o/r/pull/7", stderr: "", code: 0 }
  })
  const generate = jest.fn(async () => "Title: feat: add thing\nBody:\n## Summary\ndid it")
  const deps: PrDeps = {
    dispatch: (a) => actions.push(a),
    cwd: "/repo",
    config: { cwd: "/repo" } as ResolvedConfig,
    runGit: git,
    runGh,
    generate,
    ...over,
  }
  return { actions, git, runGh, generate, deps }
}

describe("buildPrSummaryPrompt", () => {
  it("frames a PR summary with commits, diffstat, and the required format", () => {
    const p = buildPrSummaryPrompt({
      commits: "- feat",
      diffstat: "a | 1",
      base: "master",
      branch: "f",
    })
    expect(p).toContain("pull request against `master`")
    expect(p).toContain("Title:")
    expect(p).toContain("## Test plan")
  })
})

describe("parsePrDraft", () => {
  it("splits Title: and Body:", () => {
    expect(parsePrDraft("Title: feat: x\nBody:\n## Summary\nyo")).toEqual({
      title: "feat: x",
      body: "## Summary\nyo",
    })
  })
  it("falls back to first line = title", () => {
    expect(parsePrDraft("just a title\nand a body")).toEqual({
      title: "just a title",
      body: "and a body",
    })
  })
})

describe("formatPrBody", () => {
  it("appends the footer once", () => {
    const out = formatPrBody("body")
    expect(out).toContain(PR_FOOTER)
    expect(formatPrBody(out).match(/Claude Code/g)).toHaveLength(1)
  })
})

describe("runPr", () => {
  it("detects master when main is absent", async () => {
    const h = harness({ git: { mainExists: false, masterExists: true } })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT") as { base: string }
    expect(draft.base).toBe("master")
  })

  it("notices when no base branch exists", async () => {
    const h = harness({ git: { mainExists: false, masterExists: false } })
    await runPr(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("No `main` or `master`")
  })

  it("refuses when on the base branch", async () => {
    const h = harness({ git: { mainExists: true, branch: "main" } })
    await runPr(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("base branch")
  })

  it("notices when there are no commits vs the base", async () => {
    const h = harness({ git: { commits: "  " } })
    await runPr(h.deps)
    expect((h.actions.at(-1) as { message: string }).message).toContain("No commits")
  })

  it("stages the PR draft and opens the confirm overlay", async () => {
    const h = harness()
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT") as {
      title: string
      body: string
    }
    expect(draft.title).toBe("feat: add thing")
    expect(draft.body).toContain(PR_FOOTER)
    const overlay = h.actions.find((a) => a.type === "OVERLAY_OPEN") as {
      overlay: { onConfirmCommand: string }
    }
    expect(overlay.overlay.onConfirmCommand).toBe("pr apply")
  })

  it("apply opens a draft PR with gh and reports the URL", async () => {
    const h = harness({ action: "apply", prDraft: { title: "feat: x", body: "b", base: "master" } })
    await runPr(h.deps)
    const create = h.runGh.mock.calls.find((c) => c[0][0] === "pr")!
    expect(create[0]).toEqual([
      "pr",
      "create",
      "--draft",
      "--base",
      "master",
      "--title",
      "feat: x",
      "--body",
      "b",
    ])
    expect(h.actions).toContainEqual({ type: "CLEAR_PR_DRAFT" })
    expect((h.actions.find((a) => a.type === "NOTICE") as { message: string }).message).toContain(
      "pull/7"
    )
  })

  it("apply falls back to a document overlay when gh is absent", async () => {
    const h = harness({
      action: "apply",
      prDraft: { title: "feat: x", body: "b", base: "master" },
      ghVersion: { stdout: "", stderr: "", code: 127 },
    })
    await runPr(h.deps)
    const doc = h.actions.find((a) => a.type === "OVERLAY_OPEN") as {
      overlay: { kind: string; title: string }
    }
    expect(doc.overlay).toMatchObject({ kind: "document" })
    expect(doc.overlay.title).toContain("gh not found")
    expect(h.actions).toContainEqual({ type: "CLEAR_PR_DRAFT" })
  })

  it("apply surfaces a gh failure", async () => {
    const h = harness({
      action: "apply",
      prDraft: { title: "t", body: "b", base: "master" },
      gh: { stdout: "", stderr: "no auth", code: 1 },
    })
    await runPr(h.deps)
    expect((h.actions.find((a) => a.type === "NOTICE") as { message: string }).message).toContain(
      "gh pr create failed"
    )
  })

  it("notices when there is no active model config", async () => {
    const h = harness({ config: undefined })
    await runPr(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("model config")
    expect(h.generate).not.toHaveBeenCalled()
  })

  it("surfaces a generation failure", async () => {
    const h = harness({
      generate: async () => {
        throw new Error("nope")
      },
    })
    await runPr(h.deps)
    expect((h.actions.at(-1) as { message: string }).message).toContain("generation failed: nope")
  })

  it("notices when the model returns no title", async () => {
    const h = harness({ generate: async () => "\n\n" })
    await runPr(h.deps)
    expect((h.actions.at(-1) as { message: string }).message).toContain("no PR title")
  })

  it("apply notices when there is no pending PR", async () => {
    const h = harness({ action: "apply" })
    await runPr(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("No pending PR")
  })

  it("notices an unknown action", async () => {
    const h = harness({ action: "bogus" })
    await runPr(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("Unknown /pr action")
  })

  it("cancel clears the draft", async () => {
    const h = harness({ action: "cancel", prDraft: { title: "t", body: "b", base: "master" } })
    await runPr(h.deps)
    expect(h.actions).toEqual([{ type: "CLEAR_PR_DRAFT" }])
  })
})

describe("runPr with config.git overrides", () => {
  it("targets the configured base branch instead of auto-detect", async () => {
    const h = harness({
      config: { cwd: "/repo", git: { baseBranch: "dev" } } as ResolvedConfig,
    })
    await runPr(h.deps)
    // Only the override is probed — never main/master.
    const probes = h.git.mock.calls
      .map((c) => (c[0] as string[]).join(" "))
      .filter((s) => s.startsWith("rev-parse --verify"))
    expect(probes).toEqual(["rev-parse --verify --quiet dev"])
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT")
    expect(draft && "base" in draft && draft.base).toBe("dev")
  })

  it("notices when the configured base branch does not exist", async () => {
    const git = jest.fn(async (args: string[]): Promise<ExecResult> => {
      const s = args.join(" ")
      if (s === "rev-parse --verify --quiet release") return { ...OK, code: 1 }
      return OK
    })
    const h = harness({
      runGit: git,
      config: { cwd: "/repo", git: { baseBranch: "release" } } as ResolvedConfig,
    })
    await runPr(h.deps)
    const notice = h.actions.find((a) => a.type === "NOTICE")
    expect(notice && "message" in notice && notice.message).toContain('"release"')
  })

  it("omits the PR footer when prFooter is false", async () => {
    const h = harness({
      config: { cwd: "/repo", git: { prFooter: false } } as ResolvedConfig,
    })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT")
    expect(draft && "body" in draft && draft.body).not.toContain(PR_FOOTER)
  })

  it("uses a custom footer string when configured", async () => {
    const h = harness({
      config: { cwd: "/repo", git: { prFooter: "Reviewed-by: humans" } } as ResolvedConfig,
    })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT")
    expect(draft && "body" in draft && draft.body).toContain("Reviewed-by: humans")
  })
})

describe("formatPrBody with a configured footer", () => {
  it("appends nothing when footer is null", () => {
    expect(formatPrBody("## Summary\nx", null)).toBe("## Summary\nx")
  })

  it("appends a custom footer once", () => {
    const once = formatPrBody("body", "F")
    expect(once).toBe("body\n\nF")
    expect(formatPrBody(once, "F")).toBe(once)
  })
})

describe("stacked branches", () => {
  it("bases the pull request on the recorded stack parent", async () => {
    // Opening layer 2 against the trunk instead would put layer 1's commits in
    // its diff and quietly undo the stack `/stack on` was used to build.
    const h = harness({ git: { branch: "me/ui", stackParent: "me/api" } })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT") as { base: string }
    expect(draft.base).toBe("me/api")
  })

  it("falls through to the trunk when the recorded parent is gone", async () => {
    // A merged and deleted parent leaves a stale pointer; using it anyway
    // produces a pull request the forge rejects for an unknown base ref.
    const h = harness({
      git: { branch: "me/ui", stackParent: "me/api", stackParentExists: false },
    })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT") as { base: string }
    expect(draft.base).toBe("main")
  })

  it("ignores a pointer that names the branch itself", async () => {
    const h = harness({ git: { branch: "me/ui", stackParent: "me/ui" } })
    await runPr(h.deps)
    const draft = h.actions.find((a) => a.type === "SET_PR_DRAFT") as { base: string }
    expect(draft.base).toBe("main")
  })
})
