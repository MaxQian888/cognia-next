/** @jest-environment node */
import { runProjectMining, projectClaimEvidenceHash } from "./run-project-mining"
import type { RunProjectMiningDeps, RunProjectMiningInput } from "./run-project-mining"
import type { ProjectClaimCandidate } from "@cognia/memory/extract/project-extractor"
import type { ConsolidateInput, ConsolidationOp } from "@/lib/memory/consolidate/consolidator"
import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"

const SALIENT = [
  {
    id: "m1",
    role: "user",
    text: "Why does the build break when I add a package to packages/memory/src/index.ts?",
    createdAt: 1_000,
  },
  {
    id: "m2",
    role: "assistant",
    text: "Because pnpm requires it in SERVER_ONLY_PACKAGES; the static export fails otherwise.",
    createdAt: 2_000,
  },
]

function claim(overrides: Partial<ProjectClaimCandidate> = {}): ProjectClaimCandidate {
  return {
    kind: "constraint",
    text: "Server-only packages must be listed in SERVER_ONLY_PACKAGES.",
    importance: 8,
    confidence: 0.9,
    observedAtMessageId: "m2",
    supportRole: "assistant",
    evidence: [{ kind: "message", sourceId: "m2" }],
    ...overrides,
  }
}

function input(overrides: Partial<RunProjectMiningInput> = {}): RunProjectMiningInput {
  return {
    messages: SALIENT,
    projectId: "proj-1",
    scope: "workspace",
    provenance: "user",
    config: DEFAULT_MEMORY_CONFIG,
    ...overrides,
  }
}

function deps(overrides: Partial<RunProjectMiningDeps> = {}): RunProjectMiningDeps & {
  consolidateCalls: ConsolidateInput[]
} {
  const consolidateCalls: ConsolidateInput[] = []
  return {
    extract: jest.fn(async () => [claim()]),
    consolidate: jest.fn(async (call: ConsolidateInput) => {
      consolidateCalls.push(call)
      return { applied: [{ op: "NOOP" }] as ConsolidationOp[] }
    }),
    consolidateCalls,
    ...overrides,
  }
}

describe("runProjectMining gates", () => {
  it("respects the external-content learning switch before reading attachment facts", async () => {
    const d = deps()
    const file = {
      type: "file",
      extractedContent: {
        attachmentId: "a1",
        contentHash: "a".repeat(64),
        status: "ready",
        processor: { id: "text", version: "1" },
        segments: [
          {
            id: "s1",
            text: "src/index.ts uses pnpm",
            locator: { type: "text", start: 0, end: 23 },
          },
        ],
      },
    }
    const result = await runProjectMining(
      input({
        messages: [{ ...SALIENT[0]!, parts: [file] }],
        config: { ...DEFAULT_MEMORY_CONFIG, disableLearningOnExternalContext: true },
      }),
      d
    )
    expect(result.skipReason).toBe("external_context_blocked")
    expect(d.extract).not.toHaveBeenCalled()
  })

  it("bounds attachment model work, selects relevant late content, and records partial mining", async () => {
    const extracted = jest.fn(async (request) =>
      request.attachments
        ? [
            claim({
              observedAtMessageId: "m1",
              evidence: [{ kind: "file", sourceId: request.attachments[0].sourceId }],
            }),
          ]
        : []
    )
    const d = deps({ extract: extracted })
    const file = {
      type: "file",
      extractedContent: {
        attachmentId: "a1",
        contentHash: "a".repeat(64),
        status: "ready",
        processor: { id: "text", version: "1" },
        segments: [
          {
            id: "large",
            text: "unrelated prose ".repeat(6000),
            locator: { type: "text", start: 0, end: 96000 },
          },
          {
            id: "relevant",
            text: "SERVER_ONLY_PACKAGES pnpm build constraint in src/index.ts",
            locator: { type: "page", page: 99 },
          },
        ],
      },
    }
    const result = await runProjectMining(
      input({
        messages: [
          {
            ...SALIENT[0]!,
            text: "Explain SERVER_ONLY_PACKAGES pnpm build",
            parts: [{ type: "text", text: "Explain SERVER_ONLY_PACKAGES pnpm build" }, file],
          },
          SALIENT[1]!,
        ],
        config: { ...DEFAULT_MEMORY_CONFIG, disableLearningOnExternalContext: false },
      }),
      d
    )
    expect(extracted).toHaveBeenCalledTimes(2)
    const request = extracted.mock.calls[1]![0]
    expect(request.attachments[0].text).toContain("SERVER_ONLY_PACKAGES")
    expect(request.messages).toEqual([{ id: "m1", role: "user", text: "" }])
    expect(result.attachmentCoverage?.mined).toBe(request.attachments.length)
    expect(result.attachmentCoverage!.mined).toBeLessThan(result.attachmentCoverage!.available)
    expect(result.redactedExcerpts?.has(request.attachments[0].sourceId)).toBe(true)
  })
  it("mines nothing when the mining switch is off", async () => {
    const d = deps()
    const result = await runProjectMining(
      input({ config: { ...DEFAULT_MEMORY_CONFIG, mineProjectContext: false } }),
      d
    )
    expect(result.skipReason).toBe("mining_disabled")
    expect(d.extract).not.toHaveBeenCalled()
  })

  it("mines nothing when the user turned off learning from chats", async () => {
    const d = deps()
    const result = await runProjectMining(
      input({ config: { ...DEFAULT_MEMORY_CONFIG, learnFromChats: false } }),
      d
    )
    expect(result.skipReason).toBe("mining_disabled")
    expect(d.extract).not.toHaveBeenCalled()
  })

  it("mines nothing in a temporary (incognito) session", async () => {
    const result = await runProjectMining(
      input({ config: { ...DEFAULT_MEMORY_CONFIG, temporary: true } }),
      deps()
    )
    expect(result.skipReason).toBe("temporary_session")
  })

  it("refuses a window whose text still names someone's home directory", async () => {
    const d = deps()
    const result = await runProjectMining(
      input({
        messages: [
          { ...SALIENT[0]!, text: "I ran it in /Users/someone/other-project and it failed." },
          SALIENT[1]!,
        ],
        workspaceRoots: ["/Users/me/cognia"],
      }),
      d
    )
    expect(result.skipReason).toBe("identifying_path")
    expect(d.extract).not.toHaveBeenCalled()
  })

  it("rewrites in-root absolute paths instead of refusing them", async () => {
    const d = deps()
    await runProjectMining(
      input({
        messages: [
          { ...SALIENT[0]!, text: "Open /Users/me/cognia/packages/memory/src/index.ts please" },
          SALIENT[1]!,
        ],
        workspaceRoots: ["/Users/me/cognia"],
      }),
      d
    )
    const sent = (d.extract as jest.Mock).mock.calls[0]![0] as { messages: { text: string }[] }
    expect(sent.messages[0]!.text).toContain("packages/memory/src/index.ts")
    expect(sent.messages[0]!.text).not.toContain("/Users/me")
  })

  it("skips a window with no project signal without calling the model", async () => {
    const d = deps()
    const result = await runProjectMining(
      input({
        messages: [
          { id: "m1", role: "user", text: "hello there", createdAt: 1 },
          { id: "m2", role: "assistant", text: "hi, how are you", createdAt: 2 },
        ],
      }),
      d
    )
    expect(result.skipReason).toBe("not_salient")
    expect(d.extract).not.toHaveBeenCalled()
  })
})

describe("runProjectMining consolidation", () => {
  it("keeps workspace, subtree, and branch claims in distinct consolidation namespaces", async () => {
    const d = deps({
      extract: jest.fn(async () => [
        claim(),
        claim({ pathHint: "./src\\memory//", scopeRationale: "Only this subtree" }),
        claim({ branchScoped: true, scopeRationale: "Only on the experiment branch" }),
      ]),
    })
    await runProjectMining(input({ branch: "experiment" }), d)
    expect(d.consolidateCalls).toEqual([
      expect.objectContaining({ branch: undefined, pathPattern: undefined }),
      expect.objectContaining({ branch: undefined, pathPattern: "src/memory" }),
      expect.objectContaining({ branch: "experiment", pathPattern: undefined }),
    ])
    expect(d.consolidateCalls.every((call) => call.candidates.length === 1)).toBe(true)
  })

  it.each([
    { pathHint: "../other", scopeRationale: "subtree" },
    { pathHint: "/absolute", scopeRationale: "subtree" },
    { pathHint: "C:\\project", scopeRationale: "subtree" },
    { pathHint: "src/**", scopeRationale: "subtree" },
    { pathHint: "./", scopeRationale: "subtree" },
    { pathHint: "src" },
    { branchScoped: true },
    { branchScoped: true, scopeRationale: "Only the source branch" },
  ])("refuses to widen an inapplicable claim: %j", async (fields) => {
    const d = deps({ extract: jest.fn(async () => [claim(fields)]) })
    expect((await runProjectMining(input(), d)).skipReason).toBe("no_applicable_candidates")
    expect(d.consolidate).not.toHaveBeenCalled()
  })

  it("always fails closed, so an unjudged claim is quarantined not silently added", async () => {
    const d = deps()
    await runProjectMining(input(), d)
    expect(d.consolidateCalls[0]!.failureMode).toBe("quarantine")
  })

  it("carries the claim vocabulary onto the consolidation candidate", async () => {
    const d = deps({
      extractorIdentity: { provider: "anthropic", model: "claude-haiku" },
    })
    await runProjectMining(input({ transcriptRevision: 12 }), d)
    const candidate = d.consolidateCalls[0]!.candidates[0]!
    expect(candidate.type).toBe("semantic")
    expect(candidate.projectClaim).toMatchObject({
      projectMemoryKind: "constraint",
      // Derived from the SOURCE message, not from "now" — this is the whole
      // reason `observedAt` exists separately from `createdAt`.
      observedAt: 2_000,
      confidence: 0.9,
      sourceRevision: "12",
      extractor: { provider: "anthropic", model: "claude-haiku", promptVersion: "project-v4" },
    })
  })

  it("omits the extractor stamp rather than fabricating an unknown provider", async () => {
    const d = deps()
    await runProjectMining(input(), d)
    expect(d.consolidateCalls[0]!.candidates[0]!.projectClaim?.extractor).toBeUndefined()
  })

  it("leaves observedAt unset when the source message has no timestamp", async () => {
    const d = deps()
    await runProjectMining(
      input({ messages: SALIENT.map(({ createdAt: _drop, ...rest }) => rest) }),
      d
    )
    expect(d.consolidateCalls[0]!.candidates[0]!.projectClaim?.observedAt).toBeUndefined()
  })

  it("drops a claim whose text carries PII", async () => {
    const d = deps({
      extract: jest.fn(async () => [claim({ text: "Reach the owner at a@b.com" })]),
      isPiiSafe: (text) => !text.includes("@"),
    })
    const result = await runProjectMining(input(), d)
    expect(result.skipReason).toBe("no_safe_candidates")
    expect(d.consolidate).not.toHaveBeenCalled()
  })

  it("fails closed on the whole payload when the deep PII gate refuses it", async () => {
    const d = deps({ isPayloadPiiSafe: () => false })
    const result = await runProjectMining(input(), d)
    expect(result.skipReason).toBe("payload_pii_blocked")
    expect(d.extract).not.toHaveBeenCalled()
  })

  it("returns the exact redacted excerpts that were sent, for evidence hashing", async () => {
    const d = deps({ redact: (text) => `redacted:${text}` })
    const result = await runProjectMining(input(), d)
    expect(result.redactedExcerpts?.get("m2")).toBe(`redacted:${SALIENT[1]!.text}`)
  })

  it("pins tool citations to actual parts and excludes prose and pending calls", async () => {
    const d = deps()
    await runProjectMining(
      input({
        messages: [
          SALIENT[0]!,
          {
            ...SALIENT[1]!,
            parts: [
              { type: "text", text: "[tool 0] invented success" },
              { type: "tool-bash", state: "output-available", output: "tests passed" },
              { type: "tool-bash", state: "input-available" },
            ],
          },
        ],
      }),
      d
    )
    expect(d.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ id: "m2", toolResultIndices: [1] }),
        ]),
      })
    )
  })

  it("never throws when a dependency does", async () => {
    const d = deps({
      extract: jest.fn(async () => {
        throw new Error("provider exploded")
      }),
    })
    await expect(runProjectMining(input(), d)).resolves.toEqual({ applied: [] })
  })

  it("propagates background extraction failures into the worker retry policy", async () => {
    const failure = new Error("provider unavailable")
    const d = deps({
      propagateErrors: true,
      extract: jest.fn(async () => {
        throw failure
      }),
    })
    await expect(runProjectMining(input(), d)).rejects.toBe(failure)
    expect(d.consolidate).not.toHaveBeenCalled()
  })
})

describe("projectClaimEvidenceHash", () => {
  it("changes when the evidence set changes and is stable when it does not", () => {
    const a = projectClaimEvidenceHash(claim())
    expect(projectClaimEvidenceHash(claim())).toBe(a)
    expect(
      projectClaimEvidenceHash(claim({ evidence: [{ kind: "message", sourceId: "m1" }] }))
    ).not.toBe(a)
  })
})
