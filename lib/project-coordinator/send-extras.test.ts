import type { ChatSession } from "@cognia/agent-config-types"
import { resolveProjectRoleSendExtras, type SendExtrasDeps } from "./send-extras"
import { projectRoleToolsApply } from "./config"

const deps: SendExtrasDeps = {
  listThreads: jest.fn(async () => [
    { id: "t1", title: "Fix login", createdAt: 1, updatedAt: 1 } as ChatSession,
  ]),
  prStatuses: async () => new Map([["t1", "ci_failed" as const]]),
  threadInput: (thread) => ({ thread, status: "streaming", pendingApprovals: 0 }),
  now: () => 5,
}
const on = { coordinator: { enabled: true } }

describe("projectRoleToolsApply", () => {
  it("needs a role and coordination switched on", () => {
    expect(projectRoleToolsApply({ projectRole: "thread" }, on)).toBe(true)
    expect(projectRoleToolsApply({}, on)).toBe(false)
    expect(
      projectRoleToolsApply({ projectRole: "coordinator" }, { coordinator: { enabled: false } })
    ).toBe(false)
  })
})

describe("resolveProjectRoleSendExtras", () => {
  it("gives the coordinator its tools, protocol and live project status", async () => {
    const extras = await resolveProjectRoleSendExtras(
      { id: "c", projectRole: "coordinator" },
      on,
      deps
    )
    expect(extras?.pluginTools.map((t) => t.name)).toContain("spawn_thread")
    expect(extras?.protocol).toContain("## Project coordinator")
    expect(extras?.dynamicSection).toContain("- Fix login (t1) — working")
    expect(deps.listThreads).toHaveBeenCalledWith("c")
  })

  it("gives a thread only its report tool and protocol", async () => {
    const extras = await resolveProjectRoleSendExtras({ id: "t", projectRole: "thread" }, on, deps)
    expect(extras?.pluginTools.map((t) => t.name)).toEqual(["report_to_coordinator"])
    expect(extras?.dynamicSection).toBeUndefined()
  })

  it("adds nothing to an ordinary session or with coordination off", async () => {
    await expect(resolveProjectRoleSendExtras({ id: "s" }, on, deps)).resolves.toBeUndefined()
    await expect(
      resolveProjectRoleSendExtras({ id: "c", projectRole: "coordinator" }, {}, deps)
    ).resolves.toBeUndefined()
  })
})
