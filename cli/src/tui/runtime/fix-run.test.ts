/**
 * @jest-environment node
 */
import { runFixStreaming, buildFixPrompt, tailOutput, type FixRunDeps } from "./fix-run"
import type { ShellResult } from "../../agent/run-shell"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { TuiAction } from "../state/types"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { PromptDefinitionV1, PromptScope } from "@/lib/prompts/types"
import { CLI_FIX_TESTS_PROMPT } from "@/lib/agent/prompts/cli-prompts"

const ok: ShellResult = { stdout: "", stderr: "", code: 0 }
const fail: ShellResult = { stdout: "1 failing", stderr: "AssertionError", code: 1 }

const reply = (): RunAndCaptureResult =>
  ({ text: "fixed it", usage: { inputTokens: 1, outputTokens: 1 } }) as RunAndCaptureResult

function harness(results: ShellResult[], over: Partial<FixRunDeps> = {}) {
  const actions: TuiAction[] = []
  const runTest = jest.fn(async () => results.shift() ?? ok)
  const send = jest.fn(async () => reply())
  const deps: FixRunDeps = {
    send,
    dispatch: (a) => actions.push(a),
    cwd: "/w",
    signal: new AbortController().signal,
    testCommand: "pnpm test",
    maxRounds: 3,
    runTest,
    ...over,
  }
  return { actions, runTest, send, deps }
}

describe("buildFixPrompt", () => {
  it("carries the command, exit code, round, and output; forbids self-running tests", () => {
    const p = buildFixPrompt({
      command: "pnpm test",
      code: 1,
      output: "boom",
      round: 2,
      maxRounds: 4,
    })
    expect(p).toContain("`pnpm test` failed (exit 1)")
    expect(p).toContain("round 2/4")
    expect(p).toContain("boom")
    expect(p).toContain("re-run automatically")
  })
})

describe("tailOutput", () => {
  it("keeps short output verbatim", () => {
    expect(tailOutput("short")).toBe("short")
  })
  it("truncates the head of long output", () => {
    const out = tailOutput("x".repeat(100), 10)
    expect(out).toContain("truncated")
    expect(out.endsWith("x".repeat(10))).toBe(true)
  })
})

describe("runFixStreaming", () => {
  it("short-circuits with a notice when tests already pass", async () => {
    const h = harness([ok])
    await runFixStreaming(h.deps)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.actions).toEqual([
      { type: "NOTICE", message: expect.stringContaining("already passing") },
    ])
  })

  it("fixes: red up-front, one turn, then green stops done", async () => {
    // initial=fail, advance re-run=ok
    const h = harness([fail, ok])
    await runFixStreaming(h.deps)
    expect(h.send).toHaveBeenCalledTimes(1)
    const end = h.actions.find((a) => a.type === "ACTIVITY_END")
    expect(end).toMatchObject({ status: "done" })
    expect((end as { summary: string }).summary).toContain("fixed after 1 round")
  })

  it("stops in error after exhausting the round cap", async () => {
    // maxRounds=2: initial fail, then every re-run fails
    const h = harness([fail, fail, fail, fail, fail], { maxRounds: 2 })
    await runFixStreaming(h.deps)
    const end = h.actions.find((a) => a.type === "ACTIVITY_END")
    expect(end).toMatchObject({ status: "error" })
    expect((end as { summary: string }).summary).toContain("Still failing after 2 rounds")
  })

  it("does nothing further when aborted during the up-front test run", async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness([fail], { signal: controller.signal })
    await runFixStreaming(h.deps)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.actions).toEqual([])
  })
})

function publishOverride(
  def: PromptDefinitionV1,
  body: string,
  revisionId: string,
  scope: PromptScope = "account",
  targetId = ""
): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: `pob-${revisionId}`,
        promptId: def.id,
        scope,
        targetId,
        revisionId,
        body,
        contractVersion: def.contractVersion,
      },
    ])
  )
}

describe("fix prompt Prompt Center override", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("renders a published override with the failure values", () => {
    publishOverride(
      CLI_FIX_TESTS_PROMPT,
      "Round {{round}} of {{maxRounds}}: `{{command}}` exited {{code}}.\n{{output}}",
      "por-fix-1"
    )
    expect(
      buildFixPrompt({ command: "pnpm test", code: 1, output: "boom\n", round: 2, maxRounds: 3 })
    ).toBe("Round 2 of 3: `pnpm test` exited 1.\nboom")
  })
})
