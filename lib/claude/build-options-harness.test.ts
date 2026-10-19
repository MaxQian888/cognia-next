/**
 * Coverage for the Harness Evolution wiring in `resolveSendOptions`
 * (ADR-0237): an agent's harness sections render after its persona, its
 * harness subagents register clamped to its own tools, and a probe's overlay
 * skills join the run (with their resources reachable through the run's skill
 * load context) without any library row.
 */

const loadProjectInstructions = jest.fn()
jest.mock("@/lib/claude/instructions/load", () => ({
  loadProjectInstructions: (...args: unknown[]) => loadProjectInstructions(...args),
}))

import { resolveSendOptions } from "./build-options"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { Character, ChatSession } from "@cognia/agent-config-types"
import { AGENT_CAPABILITY_GRANT_SCHEMA_VERSION } from "@cognia/agent-config-types/agent-capability-grant"
import { materializeHarnessRun } from "@/lib/harness/overlay"
import { makeComponents } from "@/lib/harness/test-fixtures"
import { loadSkillResourceForSession, releaseSkillLoadContext } from "@/lib/skills/runtime-loader"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  loadProjectInstructions.mockReset()
  loadProjectInstructions.mockResolvedValue({
    section: "",
    files: [],
    markdownAgentFiles: [],
    warnings: [],
  })
})
afterAll(dbFixture.dispose)

const baseCharacter: Character = {
  id: "char_h",
  name: "Analyst",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "PERSONA_PROMPT",
  allowedTools: ["Read", "Write"],
  createdAt: 1,
  updatedAt: 1,
}

describe("resolveSendOptions — harness sections", () => {
  it("renders standing rules, facts and tool guidance after the persona", async () => {
    const opts = await resolveSendOptions({
      character: {
        ...baseCharacter,
        harness: { guardrails: "RULE_ONE", memory: "FACT_ONE", toolGuidance: "GUIDE_ONE" },
      },
    })
    const prompt = opts.systemPrompt ?? ""
    expect(prompt).toContain("## Standing rules\n\nRULE_ONE")
    expect(prompt).toContain("## Domain facts\n\nFACT_ONE")
    expect(prompt).toContain("## Tool guidance\n\nGUIDE_ONE")
    expect(prompt.indexOf("PERSONA_PROMPT")).toBeLessThan(prompt.indexOf("RULE_ONE"))
  })

  it("adds nothing for an agent without a harness", async () => {
    const opts = await resolveSendOptions({ character: baseCharacter })
    expect(opts.systemPrompt ?? "").not.toContain("## Standing rules")
  })
})

describe("resolveSendOptions — harness subagents", () => {
  it("registers them with tools clamped to the agent's own", async () => {
    const opts = await resolveSendOptions({
      character: {
        ...baseCharacter,
        harness: {
          subagents: [
            {
              name: "checker",
              description: "Re-checks the report.",
              prompt: "Check report.md.",
              tools: ["Read", "Bash"],
            },
          ],
        },
      },
    })
    const checker = opts.agents?.checker
    expect(checker).toMatchObject({
      description: "Re-checks the report.",
      prompt: "Check report.md.",
    })
    expect(checker?.tools ?? []).not.toContain("Bash")
    expect(checker?.tools ?? []).toContain("Read")
  })

  it("lets a project markdown agent of the same name win", async () => {
    loadProjectInstructions.mockResolvedValue({
      section: "",
      files: [],
      markdownAgentFiles: [
        { id: "checker", content: "---\ndescription: project checker\n---\nbody" },
      ],
      warnings: [],
    })
    const opts = await resolveSendOptions({
      character: {
        ...baseCharacter,
        harness: { subagents: [{ name: "checker", description: "harness", prompt: "p" }] },
      },
      activeProject: {
        id: "p1",
        name: "P",
        roots: [{ id: "r", path: "/p", isPrimary: true }],
      } as never,
    })
    expect(opts.agents?.checker).toMatchObject({ description: "project checker" })
  })
})

describe("resolveSendOptions — probe overlay", () => {
  afterEach(() => releaseSkillLoadContext("probe-session"))

  it("joins the candidate's skills and serves their resources from memory", async () => {
    const { character, overlay } = materializeHarnessRun(
      { id: "snap-9", components: makeComponents({ subagents: [], toolRules: [] }) },
      baseCharacter,
      1
    )
    const opts = await resolveSendOptions({
      character,
      session: { id: "probe-session", characterId: character.id } as unknown as ChatSession,
      skillRenderMode: "hybrid",
      harnessOverlay: overlay,
    })
    expect(opts.systemPrompt ?? "").toContain("csv-report")
    await expect(
      loadSkillResourceForSession("probe-session", "csv-report", "scripts/summarize.py")
    ).resolves.toMatchObject({ ok: true })
  })

  it("drops an overlay skill a capability grant removes", async () => {
    const { character, overlay } = materializeHarnessRun(
      { id: "snap-9", components: makeComponents({ subagents: [], toolRules: [] }) },
      baseCharacter,
      1
    )
    const opts = await resolveSendOptions({
      character,
      session: { id: "probe-session", characterId: character.id } as unknown as ChatSession,
      skillRenderMode: "hybrid",
      harnessOverlay: overlay,
      capabilityGrants: [
        {
          schemaVersion: AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
          source: { kind: "harness-evolution", id: "run-1" },
          skills: { remove: ["csv-report"] },
        },
      ],
    })
    expect(opts.systemPrompt ?? "").not.toContain("csv-report")
  })
})
