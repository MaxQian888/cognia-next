import {
  buildExecutionEvidence,
  compareStanding,
  deterministicStanding,
  environmentFingerprint,
  redactEvidenceText,
  renderDeliverablesMarkdown,
  renderRolloutMarkdown,
  taskInputHash,
  type BuildEvidenceInput,
} from "./evidence"
import { makeTask } from "./test-fixtures"
import { summarizeTrajectory } from "./trajectory"

function input(overrides: Partial<BuildEvidenceInput> = {}): BuildEvidenceInput {
  return {
    snapshotId: "snap-1",
    task: makeTask({
      checks: [
        { kind: "deliverable-file", path: "report.md" },
        { kind: "output-contains", value: "13800138000" },
      ],
    }),
    environmentFingerprint: "hef1-x",
    trajectory: summarizeTrajectory([
      { kind: "action", toolName: "Write", input: { path: "report.md" } },
      { kind: "observation", toolName: "Write", output: "ok", isError: false },
      { kind: "assistant", text: "Call 13800138000 for details." },
    ]),
    deliverables: [{ path: "report.md", bytes: 10, text: "Mail me at a@example.com" }],
    filesObservable: true,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, totalCostUsd: 0.01 },
    latencyMs: 3_000,
    blockedActions: [],
    degraded: false,
    ...overrides,
  }
}

describe("taskInputHash", () => {
  it("depends on content, not on host paths or ordering", async () => {
    const a = await taskInputHash({
      prompt: "p",
      inputFiles: [
        { sourcePath: "/Users/a/x.csv", relativePath: "x.csv", sha256: "1" },
        { sourcePath: "/Users/a/y.csv", relativePath: "y.csv", sha256: "2" },
      ],
      checks: [],
    })
    const b = await taskInputHash({
      prompt: "p",
      inputFiles: [
        { sourcePath: "/tmp/y.csv", relativePath: "y.csv", sha256: "2" },
        { sourcePath: "/tmp/x.csv", relativePath: "x.csv", sha256: "1" },
      ],
      checks: [],
    })
    expect(a).toBe(b)
    const c = await taskInputHash({
      prompt: "p",
      inputFiles: [{ sourcePath: "x", relativePath: "x.csv", sha256: "9" }],
      checks: [],
    })
    expect(c).not.toBe(a)
    const git1 = await taskInputHash({
      prompt: "p",
      git: { sourceRoot: "/r", resolvedBaseSha: "abc" },
      checks: [],
    })
    const git2 = await taskInputHash({
      prompt: "p",
      git: { sourceRoot: "/other", resolvedBaseSha: "abc" },
      checks: [],
    })
    expect(git1).toBe(git2)
  })
})

describe("environmentFingerprint", () => {
  it("is stable and prefixed", async () => {
    const env = {
      runtimeFingerprint: "hrf1-a",
      isolation: "files" as const,
      maxTurns: 10,
      probePolicyHash: "p",
    }
    expect(await environmentFingerprint(env)).toMatch(/^hef1-[0-9a-f]{32}$/)
    expect(await environmentFingerprint(env)).toBe(await environmentFingerprint({ ...env }))
    expect(await environmentFingerprint({ ...env, maxTurns: 11 })).not.toBe(
      await environmentFingerprint(env)
    )
  })
})

describe("buildExecutionEvidence", () => {
  it("checks the raw output but stores a redacted copy", () => {
    const evidence = buildExecutionEvidence(input())
    expect(evidence.validation.map((v) => v.status)).toEqual(["passed", "passed"])
    expect(evidence.output).not.toContain("13800138000")
    expect(evidence.deliverables[0].text).not.toContain("a@example.com")
    expect(evidence.delivered).toBe(true)
    expect(evidence.metrics).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      costUsd: 0.01,
      latencyMs: 3_000,
      toolCalls: 1,
      toolFailures: 0,
      steps: 2,
    })
    expect(evidence.trajectory).toContain("[ACTION] Write")
    expect(evidence.inputFingerprint).toBe("task-hash")
  })

  it("prefers the runtime's final text and records errors as not delivered", () => {
    const evidence = buildExecutionEvidence(
      input({ finalText: "From the runtime", error: "sidecar exited", usage: {} })
    )
    expect(evidence.output).toBe("From the runtime")
    expect(evidence.delivered).toBe(false)
    expect(evidence.error).toBe("sidecar exited")
    expect(evidence.metrics).not.toHaveProperty("costUsd")
  })
})

describe("deterministic standing", () => {
  it("ranks delivery, then failed checks, then passed checks, then tool failures", () => {
    const good = buildExecutionEvidence(input())
    const noFile = buildExecutionEvidence(input({ deliverables: [] }))
    const errored = buildExecutionEvidence(input({ error: "boom" }))
    expect(
      compareStanding(deterministicStanding(good), deterministicStanding(noFile))
    ).toBeGreaterThan(0)
    expect(
      compareStanding(deterministicStanding(noFile), deterministicStanding(errored))
    ).toBeGreaterThan(0)
    expect(compareStanding([1, 2], [1, 2])).toBe(0)
    expect(compareStanding([1], [1, 0, 1])).toBeLessThan(0)
  })
})

describe("markdown", () => {
  it("renders a rollout for editors", () => {
    const md = renderRolloutMarkdown(
      "base1",
      buildExecutionEvidence(
        input({
          blockedActions: [{ toolName: "Bash", reason: "git push is external" }],
          degraded: true,
        })
      )
    )
    expect(md).toMatch(/^# Rollout base1/)
    expect(md).toContain("- delivered: yes")
    expect(md).toContain("- checks: 2 passed, 0 failed, 0 inconclusive")
    expect(md).toContain("cost $0.0100")
    expect(md).toContain("## Blocked by the probe policy")
    expect(md).toContain("- degraded:")
    expect(md).toContain("## Trajectory")
  })

  it("renders deliverables, binary ones by hash", () => {
    const evidence = buildExecutionEvidence(
      input({
        deliverables: [
          { path: "a.bin", bytes: 4, sha256: "abcd" },
          { path: "b.md", bytes: 2, text: "hi" },
        ],
      })
    )
    expect(renderDeliverablesMarkdown(evidence)).toBe(
      "## a.bin (4 bytes)\n\n(binary; sha256 abcd)\n\n## b.md (2 bytes)\n\nhi"
    )
    expect(renderDeliverablesMarkdown({ ...evidence, deliverables: [] })).toBe(
      "No files were produced."
    )
  })

  it("redacts secrets", () => {
    expect(redactEvidenceText("key sk-proj-abcdefghijklmnopqrstuvwxyz0123")).not.toContain(
      "sk-proj"
    )
  })
})
