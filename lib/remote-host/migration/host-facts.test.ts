import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"

import { readHostFacts } from "./host-facts"

function transportAnswering(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const call = jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
    const answer = answers[name]
    if (!answer) throw new Error(`unexpected ${name}`)
    return answer(args)
  })
  return { call: call as never, calls: call }
}

describe("readHostFacts", () => {
  it("reads each host table once per preflight, and only when asked", async () => {
    const transport = transportAnswering({
      sync_pull: (args) =>
        args.table === "workflows"
          ? { rows: [{ id: "wf-1" }, { id: 2 }], deleted_ids: [] }
          : { rows: [] },
    })
    const facts = readHostFacts(transport)
    expect([...(await facts.ids("workflows"))]).toEqual(["wf-1"])
    await facts.ids("workflows")
    expect(transport.calls).toHaveBeenCalledTimes(1)
    expect(transport.calls).toHaveBeenCalledWith("sync_pull", {
      table: "workflows",
      since: 0,
      content_protocol_version: 1,
    })
  })

  it("does not cache a read that failed", async () => {
    let fail = true
    const transport = transportAnswering({
      sync_pull: () => {
        if (fail) throw new Error("relay dropped")
        return { rows: [{ id: "c-1" }] }
      },
    })
    const facts = readHostFacts(transport)
    await expect(facts.ids("characters")).rejects.toThrow("relay dropped")
    fail = false
    expect((await facts.ids("characters")).has("c-1")).toBe(true)
  })

  it("reads plugin versions, the Bot catalog, credential candidates and external agents", async () => {
    const transport = transportAnswering({
      sync_pull: () => ({ rows: [{ id: "acme", version: "1.2.0" }, { id: "bare" }] }),
      bot_console_read: (args) =>
        args.view === "catalog"
          ? {
              entries: [
                { definitionId: "acme:digest", version: "1.2.0", pluginId: "acme" },
                { definitionId: "broken" },
              ],
            }
          : {
              groups: {
                "": [{ value: "cai_1" }],
                github: [{ value: "acct_1" }, { value: 3 }],
              },
            },
      external_agent_config_list: () => ({ configs: [{ id: "codex" }, { configId: "claude" }] }),
      scheduled_task_get: (args) => (args.taskId === "t-1" ? { id: "t-1" } : null),
      host_feature_manifest: () => buildLocalHostFeatureManifest({ platform: "headless" }),
    })
    const facts = readHostFacts(transport)
    expect([...(await facts.plugins())]).toEqual([
      ["acme", "1.2.0"],
      ["bare", ""],
    ])
    expect([...(await facts.botCatalog()).values()]).toEqual([
      { definitionId: "acme:digest", version: "1.2.0", pluginId: "acme" },
    ])
    expect([...(await facts.botCredentialIds())].sort()).toEqual(["acct_1", "cai_1"])
    expect([...(await facts.externalAgentIds())].sort()).toEqual(["claude", "codex"])
    expect(await facts.hasScheduledTask("t-1")).toBe(true)
    expect(await facts.hasScheduledTask("t-2")).toBe(false)
    expect((await facts.manifest())?.platform).toBe("headless")
  })

  it("answers null for a manifest it cannot parse", async () => {
    const facts = readHostFacts(transportAnswering({ host_feature_manifest: () => ({ nope: 1 }) }))
    expect(await facts.manifest()).toBeNull()
  })
})
