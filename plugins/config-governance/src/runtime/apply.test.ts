import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import type { AuditRun, Hunk } from "../model"
import { applySelected, planApply } from "./apply"

function hunk(
  findingId: string,
  surfaceKey: string,
  startLine: number,
  before: string[],
  after: string[]
): Hunk {
  return {
    findingId,
    surfaceKey,
    startLine,
    endLine: startLine + before.length - 1,
    before,
    after,
    proposedOnly: false,
  }
}

const run: AuditRun = {
  id: "r",
  workspaceId: "w",
  startedAt: 0,
  finishedAt: 0,
  targetModel: "m",
  surfaces: [
    {
      surface: { key: "a", name: "A.md" } as AuditRun["surfaces"][number]["surface"],
      textHash: "",
      lineCount: 3,
    },
    {
      surface: { key: "b", name: "B.md" } as AuditRun["surfaces"][number]["surface"],
      textHash: "",
      lineCount: 1,
    },
  ],
  findings: [
    {
      id: "mv",
      group: "dated-text",
      pattern: "p",
      location: { surfaceKey: "a", startLine: 2, endLine: 2 },
      evidence: "",
      reason: "",
      confidence: "high",
      action: "move",
      moveTo: "b",
      sources: ["judge"],
    },
    {
      id: "rw",
      group: "dated-text",
      pattern: "p",
      location: { surfaceKey: "a", startLine: 1, endLine: 1 },
      evidence: "",
      reason: "",
      confidence: "high",
      action: "rewrite",
      sources: ["judge"],
    },
  ],
  hunks: [
    hunk("rw", "a", 1, ["one"], ["ONE"]),
    hunk("mv", "a", 2, ["two"], []),
    { ...hunk("mv", "b", 2, [], ["", "two"]), endLine: 1 },
  ],
  failedSources: [],
  notes: [],
}

function config(
  texts: Record<string, string>,
  applyEdit: jest.Mock = jest.fn(async (edit: { key: string }) => ({
    key: edit.key,
    version: "v2",
  }))
) {
  return {
    readSurface: jest.fn(async (key: string) =>
      key in texts ? { key, text: texts[key]!, version: "v1" } : null
    ),
    applyEdit,
  } as unknown as PluginAgentConfigAPI & { applyEdit: typeof applyEdit }
}

const deps = (agentConfig: PluginAgentConfigAPI) => ({
  agentConfig,
  now: () => 5,
  newId: () => "change",
  summarize: (name: string, count: number) => `apply ${count} to ${name}`,
  record: jest.fn(async () => {}),
})

describe("planApply", () => {
  it("groups the selected hunks by surface, move destinations first", () => {
    expect(
      planApply(run, new Set(["mv", "rw"])).map((group) => [group.surfaceKey, group.hunks.length])
    ).toEqual([
      ["b", 1],
      ["a", 2],
    ])
    expect(planApply(run, new Set(["rw"])).map((group) => group.surfaceKey)).toEqual(["a"])
  })
})

describe("applySelected", () => {
  it("writes each surface once, with its version and summary, and records the change", async () => {
    const agentConfig = config({ a: "one\ntwo\nthree", b: "keep" })
    const d = deps(agentConfig)
    const results = await applySelected(d, run, new Set(["mv", "rw"]))
    expect(results).toEqual([
      { surfaceKey: "b", status: "applied", hunks: 1, resultKey: "b" },
      { surfaceKey: "a", status: "applied", hunks: 2, resultKey: "a" },
    ])
    expect(agentConfig.applyEdit).toHaveBeenNthCalledWith(1, {
      key: "b",
      text: "keep\n\ntwo",
      version: "v1",
      workspaceId: "w",
      summary: "apply 1 to B.md",
    })
    expect(agentConfig.applyEdit).toHaveBeenNthCalledWith(2, {
      key: "a",
      text: "ONE\nthree",
      version: "v1",
      workspaceId: "w",
      summary: "apply 2 to A.md",
    })
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceKey: "a", findingIds: ["rw", "mv"], hunks: 2, at: 5 })
    )
  })

  it("reports stale, declined, gone and failed surfaces without stopping", async () => {
    const declined = Object.assign(new Error("no"), { code: "agent_config_consent_denied" })
    const results = await applySelected(
      deps(
        config(
          { a: "changed\ntwo" },
          jest.fn(async () => {
            throw declined
          })
        )
      ),
      run,
      new Set(["mv", "rw"])
    )
    expect(results.map((result) => result.status)).toEqual(["gone", "stale"])
    const declinedResults = await applySelected(
      deps(
        config(
          { a: "one\ntwo", b: "" },
          jest.fn(async () => {
            throw declined
          })
        )
      ),
      run,
      new Set(["rw"])
    )
    expect(declinedResults[0]!.status).toBe("declined")
    const versionStale = Object.assign(new Error("stale"), { code: "agent_config_stale" })
    expect(
      (
        await applySelected(
          deps(
            config(
              { a: "one" },
              jest.fn(async () => {
                throw versionStale
              })
            )
          ),
          run,
          new Set(["rw"])
        )
      )[0]!.status
    ).toBe("stale")
    const failed = await applySelected(
      deps(
        config(
          { a: "one" },
          jest.fn(async () => {
            throw new Error("disk")
          })
        )
      ),
      run,
      new Set(["rw"])
    )
    expect(failed[0]).toMatchObject({ status: "failed", error: "disk" })
  })
})
