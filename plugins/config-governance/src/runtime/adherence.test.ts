import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import { collectSessions, deriveChecks, runAdherence, type SessionSourceLike } from "./adherence"
import { PROMPT_IDS } from "../prompts"

function sessions(): SessionSourceLike & { listSessions: jest.Mock; getMessages: jest.Mock } {
  return {
    listSessions: jest.fn(async () => [
      { id: "new", projectId: "w", createdAt: 300 },
      { id: "mid", projectId: "w", createdAt: new Date(200) },
      { id: "other", projectId: "x", createdAt: 250 },
      { id: "empty", projectId: "w", createdAt: 150 },
      { id: "old", projectId: "w", createdAt: 100 },
    ]),
    getMessages: jest.fn(async (id: string) =>
      id === "empty"
        ? [{ id: "u", role: "user", parts: [] }]
        : [
            { id: "u", role: "user", parts: [] },
            {
              id: "a",
              role: "assistant",
              parts: [
                {
                  type: "tool-bash",
                  input: { command: id === "old" ? "git push --force" : "git status" },
                },
              ],
            },
          ]
    ),
  }
}

describe("collectSessions", () => {
  it("filters by workspace and time window and drops sessions without tool calls", async () => {
    const source = sessions()
    const collected = await collectSessions(source, { workspaceId: "w", limit: 10 })
    expect(collected.map((entry) => entry.sessionId)).toEqual(["new", "mid", "old"])
    expect(source.listSessions).toHaveBeenCalledWith({
      projectId: "w",
      limit: 30,
      sortBy: "createdAt",
      sortOrder: "desc",
    })
    expect(
      (await collectSessions(source, { workspaceId: "w", since: 200 })).map(
        (entry) => entry.sessionId
      )
    ).toEqual(["new", "mid"])
    expect(
      (await collectSessions(source, { workspaceId: "w", until: 200 })).map(
        (entry) => entry.sessionId
      )
    ).toEqual(["old"])
    expect(
      (await collectSessions(source, { workspaceId: null, limit: 2 })).map(
        (entry) => entry.sessionId
      )
    ).toEqual(["new", "mid"])
  })

  it("stops reading when cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await collectSessions(sessions(), { workspaceId: "w", signal: controller.signal })
    ).toEqual([])
  })
})

describe("runAdherence", () => {
  it("replays checks over the collected sessions", async () => {
    const stored = await runAdherence(sessions(), {
      workspaceId: "w",
      checks: [
        {
          id: "C",
          kind: "forbid",
          trigger: { family: "shell", command: "^git push --force" },
          scope: "turn",
          summary: "s",
          rule: {
            surfaceKey: "k",
            surfaceName: "n",
            startLine: 1,
            endLine: 1,
            text: "Never force-push.",
          },
        },
      ],
      falseMatches: new Set(),
      roots: [],
      now: () => 9,
      since: 0,
    })
    expect(stored).toMatchObject({ ranAt: 9, sessions: 3, since: 0 })
    expect(stored.results[0]).toMatchObject({ opportunities: 1, violated: 1 })
  })
})

describe("deriveChecks", () => {
  function config(): PluginAgentConfigAPI {
    return {
      listSurfaces: jest.fn(async () => ({
        workspaceId: "w",
        failed: [],
        surfaces: [
          { key: "instruction-file:a", source: "instruction-file", name: "CLAUDE.md" },
          { key: "skill:b", source: "skill", name: "skill" },
          { key: "instruction-file:secret", source: "instruction-file", name: "SECRET.md" },
          {
            key: "instruction-file:gone",
            source: "instruction-file",
            name: "GONE.md",
            unavailable: true,
          },
        ],
      })),
      readSurface: jest.fn(async (key: string) =>
        key === "instruction-file:a"
          ? { key, text: "- Never run `git push --force`." }
          : key === "instruction-file:secret"
            ? { key, text: "- run with token sk-1" }
            : { key, text: "- run the build" }
      ),
      redactForModel: jest.fn((text: string) => (text.includes("sk-1") ? null : text)),
    } as unknown as PluginAgentConfigAPI
  }

  it("asks once over the always-loaded, redactable rules and stores the checks", async () => {
    const complete = jest.fn(async () =>
      JSON.stringify({
        checks: [
          {
            rule: "R1",
            kind: "forbid",
            trigger: { family: "shell", command: "^git push --force" },
          },
        ],
      })
    )
    const stored = await deriveChecks(
      {
        agentConfig: config(),
        llm: { complete },
        resolvePrompt: async (id) => `system:${id}`,
        now: () => 7,
      },
      "w"
    )
    expect(complete).toHaveBeenCalledTimes(1)
    const [messages] = complete.mock.calls[0] as unknown as [Array<{ content: string }>]
    expect(messages[0]!.content).toBe(`system:${PROMPT_IDS.derive}`)
    expect(messages[1]!.content).toContain("R1 (CLAUDE.md, line 1)")
    expect(messages[1]!.content).not.toContain("sk-1")
    expect(messages[1]!.content).not.toContain("run the build")
    expect(stored).toMatchObject({ derivedAt: 7, notCheckable: 0, rejected: 0 })
    expect(stored.checks).toHaveLength(1)
  })

  it("skips the model call when no rule is checkable", async () => {
    const agentConfig = {
      ...config(),
      listSurfaces: jest.fn(async () => ({ workspaceId: "w", failed: [], surfaces: [] })),
    } as unknown as PluginAgentConfigAPI
    const complete = jest.fn()
    expect(
      await deriveChecks(
        { agentConfig, llm: { complete }, resolvePrompt: async () => "", now: () => 1 },
        "w"
      )
    ).toEqual({
      derivedAt: 1,
      checks: [],
      notCheckable: 0,
      rejected: 0,
    })
    expect(complete).not.toHaveBeenCalled()
  })
})
