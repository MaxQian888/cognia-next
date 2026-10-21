import type { PluginAgentConfigAPI, PluginAgentConfigSurface } from "@cognia/plugin-sdk"

import type { LlmBridge, LlmMessage } from "../engine/llm"
import { PROMPT_IDS } from "../prompts"
import { AuditAbortedError, runAudit, selectSurfaces } from "./audit"

function surface(
  key: string,
  partial: Partial<PluginAgentConfigSurface> = {}
): PluginAgentConfigSurface {
  return {
    key,
    source: "instruction-file",
    kind: "instructions",
    name: key,
    builtIn: false,
    modified: false,
    edit: "source",
    ...partial,
  } as PluginAgentConfigSurface
}

const CLAUDE = [
  "# Rules",
  "- You MUST run `pnpm typecheck` before committing.",
  "- See `lib/gone.ts`.",
  "- token=sk-live",
].join("\n")
const AGENTS = ["# Agents", "- Skip pnpm typecheck before committing anything."].join("\n")

function agentConfig(overrides: Partial<PluginAgentConfigAPI> = {}): PluginAgentConfigAPI {
  const texts: Record<string, string> = {
    "instruction-file:/r/CLAUDE.md": CLAUDE,
    "instruction-file:/r/AGENTS.md": AGENTS,
    "skill:empty": "",
  }
  return {
    listSurfaces: jest.fn(async () => ({
      workspaceId: "w",
      surfaces: [
        surface("instruction-file:/r/CLAUDE.md", { path: "/r/CLAUDE.md", loadOrder: 1 }),
        surface("instruction-file:/r/AGENTS.md", { path: "/r/AGENTS.md", loadOrder: 0 }),
        surface("skill:empty", { source: "skill" }),
        surface("code:shipped", { source: "code", builtIn: true }),
      ],
      failed: ["character" as const],
    })),
    readSurface: jest.fn(async (key: string) =>
      key in texts ? { key, text: texts[key]!, version: `v-${key}` } : null
    ),
    readFacts: jest.fn(async () => {
      throw new Error("no facts")
    }),
    checkReferences: jest.fn(async (input: { paths?: string[]; scripts?: string[] }) => ({
      paths: (input.paths ?? []).map((path) => ({
        path,
        status: path === "lib/gone.ts" ? ("missing" as const) : ("exists" as const),
      })),
      scripts: (input.scripts ?? []).map((name) => ({ name, status: "defined" as const })),
    })),
    readProvenance: jest.fn(async (key: string) =>
      key.endsWith("CLAUDE.md")
        ? [{ line: 2, commit: "abc", authoredAtMs: Date.UTC(2025, 0, 1) }]
        : [{ line: 2, commit: "def", authoredAtMs: Date.UTC(2026, 0, 1) }]
    ),
    redactForModel: jest.fn((text: string) => text.replaceAll("sk-live", "[REDACTED]")),
    applyEdit: jest.fn(),
    ...overrides,
  } as unknown as PluginAgentConfigAPI
}

function llm(answer: (messages: LlmMessage[]) => string): LlmBridge & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = []
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages)
      return answer(messages)
    },
  }
}

const deps = (extra: Partial<Parameters<typeof runAudit>[0]> = {}) => ({
  agentConfig: agentConfig(),
  resolvePrompt: async (id: string) => `system:${id}`,
  now: () => 1000,
  newId: () => "run-1",
  ...extra,
})

const options = {
  workspaceId: "w",
  includeShipped: false,
  targetModel: "claude-opus-5-5",
  judgeModel: "judge",
}

describe("selectSurfaces", () => {
  it("skips shipped prompts unless asked, keeps the priority order and caps", () => {
    const surfaces = [
      surface("code:a", { source: "code", builtIn: true }),
      surface("skill:b", { source: "skill" }),
      surface("instruction-file:c"),
    ]
    expect(
      selectSurfaces(surfaces, { includeShipped: false }).selected.map((entry) => entry.key)
    ).toEqual(["instruction-file:c", "skill:b"])
    expect(selectSurfaces(surfaces, { includeShipped: true, maxSurfaces: 1 })).toMatchObject({
      capped: 2,
    })
    expect(
      selectSurfaces(surfaces, { includeShipped: false, surfaceKeys: ["code:a"] }).selected.map(
        (entry) => entry.key
      )
    ).toEqual(["code:a"])
    expect(
      selectSurfaces([surface("x", { unavailable: true })], { includeShipped: true }).selected
    ).toEqual([])
  })
})

describe("runAudit", () => {
  it("runs the deterministic checks alone without a model", async () => {
    const run = await runAudit(deps(), options)
    expect(run.surfaces.map((entry) => [entry.surface.key, entry.skipped])).toEqual([
      ["instruction-file:/r/AGENTS.md", "model-unavailable"],
      ["instruction-file:/r/CLAUDE.md", "model-unavailable"],
      ["skill:empty", "empty"],
    ])
    expect(run.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: "stale-fact",
          evidence: "lib/gone.ts",
          confidence: "high",
          proposedOnly: true,
        }),
        expect.objectContaining({
          pattern: "pressure-language",
          confidence: "low",
          action: "flag",
        }),
      ])
    )
    expect(run.hunks).toEqual([])
    expect(run.failedSources).toEqual(["character"])
    expect(run.notes).toContain("facts-unavailable")
    expect(run.judgeModel).toBeUndefined()
  })

  it("judges redacted text, runs the conflict pass with dates and cuts hunks against the original", async () => {
    const bridge = llm((messages) => {
      const system = messages[0]!.content
      const user = messages[1]!.content
      if (system === `system:${PROMPT_IDS.conflicts}`) {
        expect(user).toContain("last changed 2025-01-01")
        expect(user).toContain("last changed 2026-01-01")
        // The model calls CLAUDE.md (B) newer; its line dates say otherwise.
        return JSON.stringify({
          pairs: [
            {
              pair: "P1",
              verdict: "conflict",
              newer: "B",
              action: "remove",
              reason: "newer rule wins",
            },
          ],
        })
      }
      expect(system).toBe(`system:${PROMPT_IDS.judge}`)
      expect(user).not.toContain("sk-live")
      if (user.includes("You MUST")) {
        return JSON.stringify({
          findings: [
            {
              pattern: "pressure-language",
              startLine: 2,
              evidence: "You MUST run",
              reason: "Shouted.",
              confidence: "high",
              action: "rewrite",
              replacement: "- Run `pnpm typecheck` before committing.",
            },
            {
              pattern: "fossil",
              startLine: 4,
              evidence: "token=[REDACTED]",
              reason: "Leftover.",
              confidence: "high",
              action: "rewrite",
              replacement: "- none",
            },
          ],
        })
      }
      return '{"findings":[]}'
    })
    const run = await runAudit(deps({ llm: bridge }), options)
    expect(bridge.calls).toHaveLength(3)
    expect(run.judgeModel).toBe("judge")
    expect(run.findings.map((finding) => finding.pattern)).toEqual(
      expect.arrayContaining(["pressure-language", "conflict", "stale-fact"])
    )
    const rewrite = run.hunks.find((hunk) => hunk.before[0]?.includes("You MUST"))
    expect(rewrite?.after).toEqual(["- Run `pnpm typecheck` before committing."])
    // The rewrite over the redacted line is withheld rather than writing a placeholder.
    expect(
      run.notes.some(
        (note) => note.startsWith("hunk-withheld:") && note.endsWith(":redacted-region")
      )
    ).toBe(true)
    const conflict = run.findings.find((finding) => finding.pattern === "conflict")!
    expect(conflict).toMatchObject({ action: "flag", confidence: "medium", proposedOnly: true })
    expect(conflict.location.surfaceKey).toBe("instruction-file:/r/AGENTS.md")
    expect(run.hunks.some((hunk) => hunk.findingId === conflict.id)).toBe(false)
  })

  it("draws signals and reference claims from the redacted text", async () => {
    const config = agentConfig({
      readSurface: jest.fn(async (key: string) =>
        key === "instruction-file:/r/CLAUDE.md"
          ? { key, text: "- You MUST pass sk-live to `scripts/sk-live.sh`.", version: "v" }
          : null
      ),
    })
    const run = await runAudit(deps({ agentConfig: config }), options)
    expect(run.findings.length).toBeGreaterThan(0)
    expect(JSON.stringify(run.findings)).not.toContain("sk-live")
    const checked = (config.checkReferences as jest.Mock).mock.calls.flat()
    expect(JSON.stringify(checked)).not.toContain("sk-live")
  })

  it("keeps going when a judgment fails, and withholds text that cannot be redacted", async () => {
    const config = agentConfig({
      redactForModel: jest.fn((text: string) => (text.includes("sk-live") ? null : text)),
    })
    const bridge = llm(() => "not json")
    const run = await runAudit(deps({ agentConfig: config, llm: bridge }), options)
    const byKey = new Map(run.surfaces.map((entry) => [entry.surface.key, entry]))
    expect(byKey.get("instruction-file:/r/CLAUDE.md")).toMatchObject({
      withheld: true,
      skipped: "withheld",
    })
    expect(byKey.get("instruction-file:/r/AGENTS.md")?.skipped).toBe("model-error")
    expect(
      run.notes.some((note) => note.startsWith("judge-failed:instruction-file:/r/AGENTS.md"))
    ).toBe(true)
    // Only the AGENTS.md judgment was asked; the withheld surface never reached the model.
    expect(bridge.calls.every((messages) => !messages[1]!.content.includes("sk-live"))).toBe(true)
  })

  it("stops when cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runAudit(deps({ signal: controller.signal }), options)).rejects.toBeInstanceOf(
      AuditAbortedError
    )
  })

  it("reports progress per surface", async () => {
    const progress = jest.fn()
    await runAudit(deps({ onProgress: progress }), options)
    expect(progress).toHaveBeenCalledWith(0, 3, "instruction-file:/r/AGENTS.md")
    expect(progress).toHaveBeenLastCalledWith(3, 3, "")
  })
})
