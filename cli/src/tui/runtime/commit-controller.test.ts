/**
 * @jest-environment node
 */
import {
  runCommit,
  buildCommitMessagePrompt,
  formatCommitMessage,
  COAUTHOR_TRAILER,
  type CommitDeps,
} from "./commit-controller"
import type { ExecResult } from "../../agent/run-git"
import type { TuiAction } from "../state/types"
import type { ResolvedConfig } from "../../config/schema"

const OK: ExecResult = { stdout: "", stderr: "", code: 0 }

interface GitState {
  branch?: string
  branchCode?: number
  stagedQuietCode?: number // 0 = nothing staged, 1 = staged
  addCode?: number
  commit?: ExecResult
}

function makeGit(st: GitState) {
  return jest.fn(async (args: string[]): Promise<ExecResult> => {
    const s = args.join(" ")
    if (s === "rev-parse --abbrev-ref HEAD")
      return { stdout: st.branch ?? "feature/x", stderr: "", code: st.branchCode ?? 0 }
    if (s === "diff --cached --quiet") return { ...OK, code: st.stagedQuietCode ?? 1 }
    if (s === "diff --cached") return { stdout: "DIFF BODY", stderr: "", code: 0 }
    if (s === "diff --cached --name-only") return { stdout: "a.ts\nb.ts\n", stderr: "", code: 0 }
    if (s === "add -A") return { ...OK, code: st.addCode ?? 0 }
    if (args[0] === "commit")
      return st.commit ?? { stdout: "[feature/x abc123] feat: x", stderr: "", code: 0 }
    return OK
  })
}

function harness(over: Partial<CommitDeps> & { git?: GitState } = {}) {
  const actions: TuiAction[] = []
  const git = makeGit(over.git ?? {})
  const generate = jest.fn(async () => "feat(cli): add the thing\n\nBecause it was missing.")
  const deps: CommitDeps = {
    dispatch: (a) => actions.push(a),
    cwd: "/repo",
    config: { cwd: "/repo" } as ResolvedConfig,
    runGit: git,
    generate,
    ...over,
  }
  return { actions, git, generate, deps }
}

describe("buildCommitMessagePrompt", () => {
  it("frames a Conventional-Commit request with the diff and files", () => {
    const p = buildCommitMessagePrompt({ diff: "DIFF", changedFiles: "a.ts", branch: "feature/x" })
    expect(p).toContain("Conventional Commit")
    expect(p).toContain("feature/x")
    expect(p).toContain("a.ts")
    expect(p).toContain("DIFF")
    expect(p).toContain("72 characters or fewer")
  })
})

describe("formatCommitMessage", () => {
  it("appends the Co-Authored-By trailer as its own paragraph", () => {
    const out = formatCommitMessage("feat: x\n\nbody")
    expect(out).toContain(COAUTHOR_TRAILER)
    expect(out).toMatch(/body\n\nCo-Authored-By/)
  })
  it("does not double the trailer when already present", () => {
    const raw = `feat: x\n\n${COAUTHOR_TRAILER}`
    const out = formatCommitMessage(raw)
    expect(out.match(/Co-Authored-By/g)).toHaveLength(1)
  })
})

describe("runCommit", () => {
  it("refuses to commit directly to master", async () => {
    const h = harness({ git: { branch: "master" } })
    await runCommit(h.deps)
    expect(h.generate).not.toHaveBeenCalled()
    expect(h.actions[0]).toMatchObject({ type: "NOTICE" })
    expect((h.actions[0] as { message: string }).message).toContain("Refusing to commit")
  })

  it("notices when not in a git repo", async () => {
    const h = harness({ git: { branchCode: 1 } })
    await runCommit(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("Not a git repository")
  })

  it("opens the stage-all confirm when nothing is staged", async () => {
    const h = harness({ git: { stagedQuietCode: 0 } })
    await runCommit(h.deps)
    const overlay = h.actions.find((a) => a.type === "OVERLAY_OPEN") as {
      overlay: { kind: string; onConfirmCommand: string }
    }
    expect(overlay.overlay).toMatchObject({ kind: "confirm", onConfirmCommand: "commit stage-all" })
    expect(h.generate).not.toHaveBeenCalled()
  })

  it("generates a message and stages it for confirmation", async () => {
    const h = harness({ git: { stagedQuietCode: 1 } })
    await runCommit(h.deps)
    expect(h.generate).toHaveBeenCalledTimes(1)
    const draft = h.actions.find((a) => a.type === "SET_COMMIT_DRAFT") as { message: string }
    expect(draft.message).toContain(COAUTHOR_TRAILER)
    const overlay = h.actions.find((a) => a.type === "OVERLAY_OPEN") as {
      overlay: { onConfirmCommand: string }
    }
    expect(overlay.overlay.onConfirmCommand).toBe("commit apply")
  })

  it("stage-all runs `git add -A` then generates", async () => {
    const h = harness({ action: "stage-all", git: { stagedQuietCode: 1 } })
    await runCommit(h.deps)
    expect(h.git).toHaveBeenCalledWith(["add", "-A"], "/repo")
    expect(h.generate).toHaveBeenCalledTimes(1)
  })

  it("apply commits with -m and never --no-verify, then clears the draft", async () => {
    const h = harness({ action: "apply", commitDraft: { message: "feat: x\n\nbody" } })
    await runCommit(h.deps)
    const commitCall = h.git.mock.calls.find((c) => c[0][0] === "commit")!
    expect(commitCall[0]).toEqual(["commit", "-m", "feat: x\n\nbody"])
    expect(commitCall[0]).not.toContain("--no-verify")
    expect(h.actions).toContainEqual({ type: "CLEAR_COMMIT_DRAFT" })
    expect(
      h.actions.some(
        (a) => a.type === "NOTICE" && /Committed/.test((a as { message: string }).message)
      )
    ).toBe(true)
  })

  it("apply surfaces a hook/commitlint rejection and never retries with --no-verify", async () => {
    const h = harness({
      action: "apply",
      commitDraft: { message: "bad" },
      git: { commit: { stdout: "", stderr: "subject may not be empty", code: 1 } },
    })
    await runCommit(h.deps)
    const notice = h.actions.find((a) => a.type === "NOTICE") as { message: string }
    expect(notice.message).toContain("Commit rejected")
    expect(notice.message).toContain("--no-verify is never used")
    // only one commit attempt — no bypass retry
    expect(h.git.mock.calls.filter((c) => c[0][0] === "commit")).toHaveLength(1)
    expect(h.actions).toContainEqual({ type: "CLEAR_COMMIT_DRAFT" })
  })

  it("notices when there is no active model config", async () => {
    const h = harness({ config: undefined, git: { stagedQuietCode: 1 } })
    await runCommit(h.deps)
    expect(
      h.actions.some(
        (a) => a.type === "NOTICE" && /model config/.test((a as { message: string }).message)
      )
    ).toBe(true)
    expect(h.generate).not.toHaveBeenCalled()
  })

  it("surfaces a generation failure", async () => {
    const h = harness({
      git: { stagedQuietCode: 1 },
      generate: async () => {
        throw new Error("nope")
      },
    })
    await runCommit(h.deps)
    expect(
      h.actions.some(
        (a) =>
          a.type === "NOTICE" && /generation failed: nope/.test((a as { message: string }).message)
      )
    ).toBe(true)
  })

  it("notices when the model returns an empty message", async () => {
    const h = harness({ git: { stagedQuietCode: 1 }, generate: async () => "   " })
    await runCommit(h.deps)
    expect(
      h.actions.some(
        (a) =>
          a.type === "NOTICE" && /empty commit message/.test((a as { message: string }).message)
      )
    ).toBe(true)
  })

  it("notices a failed `git add -A` during stage-all", async () => {
    const h = harness({ action: "stage-all", git: { addCode: 1 } })
    await runCommit(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("git add failed")
  })

  it("notices an unknown action", async () => {
    const h = harness({ action: "bogus" })
    await runCommit(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("Unknown /commit action")
  })

  it("apply notices when there is no pending draft", async () => {
    const h = harness({ action: "apply" })
    await runCommit(h.deps)
    expect((h.actions[0] as { message: string }).message).toContain("No pending commit")
  })

  it("cancel clears the pending draft", async () => {
    const h = harness({ action: "cancel", commitDraft: { message: "x" } })
    await runCommit(h.deps)
    expect(h.actions).toEqual([{ type: "CLEAR_COMMIT_DRAFT" }])
  })
})
