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
  listSchedules: jest.fn(async () => []),
  markSetupOffered: jest.fn(),
}
// Setup already offered, so these cases see only the status digest.
const on = { coordinator: { enabled: true, setupOfferedAt: 1 } }

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

  it("offers setup once, on a new project's first coordinator turn", async () => {
    const fresh = {
      coordinator: { enabled: true },
      roots: [{ id: "r1", path: "/src/app", isPrimary: true }],
    }
    const empty: SendExtrasDeps = {
      ...deps,
      listThreads: jest.fn(async () => []),
      listSchedules: jest.fn(async () => [
        { name: "Nightly deps", status: "active" },
      ]) as unknown as SendExtrasDeps["listSchedules"],
      markSetupOffered: jest.fn(),
    }
    const extras = await resolveProjectRoleSendExtras(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      fresh,
      empty
    )
    expect(extras?.dynamicSection).toContain("## Project status")
    expect(extras?.dynamicSection).toContain("## Project setup (first turn only)")
    expect(extras?.dynamicSection).toContain("- Nightly deps (active)")
    expect(empty.markSetupOffered).toHaveBeenCalledWith("p1", 5)
  })

  it("does not offer setup once threads exist, or when schedules cannot be read", async () => {
    const markSetupOffered = jest.fn()
    const extras = await resolveProjectRoleSendExtras(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      { coordinator: { enabled: true } },
      { ...deps, markSetupOffered }
    )
    expect(extras?.dynamicSection).not.toContain("Project setup")
    expect(markSetupOffered).not.toHaveBeenCalled()

    const failing = await resolveProjectRoleSendExtras(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      { coordinator: { enabled: true } },
      {
        ...deps,
        listThreads: async () => [],
        listSchedules: async () => {
          throw new Error("db closed")
        },
        markSetupOffered,
      }
    )
    expect(failing?.dynamicSection).toContain("Project setup")
    expect(markSetupOffered).toHaveBeenCalled()
  })
})
