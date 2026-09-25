/**
 * The scheduler write gate.
 *
 * Every case here corresponds to a setting that used to change nothing, so the
 * assertions are deliberately about the SETTING having an effect rather than
 * about the shape of the return value.
 */

import type { SchedulerPermissionPolicy } from "@/types/scheduler"
import { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"
import {
  authorizeTaskWrite,
  assertTaskWriteAllowed,
  verdictNeedsConfirmation,
} from "./write-authority"

jest.mock("./host-support", () => ({
  ...jest.requireActual<typeof import("./host-support")>("./host-support"),
  getTaskTypeHostSupport: jest.fn(() => ({ supported: true, missing: [], requires: [] })),
  describeUnsupportedTaskType: jest.fn(() => "unsupported here"),
}))

const { getTaskTypeHostSupport } =
  jest.requireMock<jest.Mocked<typeof import("./host-support")>>("./host-support")

function policy(overrides: Partial<SchedulerPermissionPolicy> = {}): SchedulerPermissionPolicy {
  return { ...DEFAULT_PERMISSION_POLICY, confirmationRequired: [], ...overrides }
}

function deps(
  overrides: {
    policy?: Partial<SchedulerPermissionPolicy>
    owned?: number
  } = {}
) {
  return {
    loadPolicy: async () => policy(overrides.policy),
    countTasksBySource: async () => overrides.owned ?? 0,
  }
}

beforeEach(() => {
  getTaskTypeHostSupport.mockReturnValue({ supported: true, missing: [], requires: [] })
})

describe("authorizeTaskWrite", () => {
  it("never gates a person acting in the UI", async () => {
    // The user is the authority the policy protects. Gating them would let
    // someone lock themselves out of their own scheduler with a setting.
    const verdict = await authorizeTaskWrite(
      { taskType: "script", source: "user" },
      deps({ policy: { scriptTasksEnabled: false, maxTasksPerSource: 0 }, owned: 99 })
    )
    expect(verdict).toEqual({ allowed: true })
  })

  it("refuses a type this host cannot run, before any policy question", async () => {
    getTaskTypeHostSupport.mockReturnValue({
      supported: false,
      reason: "desktop-only",
      missing: ["desktop-shell"],
      requires: ["desktop-shell"],
    })
    let policyRead = false

    const verdict = await authorizeTaskWrite(
      { taskType: "script", source: "agent" },
      {
        loadPolicy: async () => {
          policyRead = true
          return policy()
        },
        countTasksBySource: async () => 0,
      }
    )

    expect(verdict).toMatchObject({ allowed: false, reason: "unsupported-on-host" })
    // Telling an agent "quota reached" for a task that could never have run
    // here is a misleading answer, so the host gate has to come first.
    expect(policyRead).toBe(false)
  })

  it("honours scriptTasksEnabled for a non-user source", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "script", source: "plugin", pluginId: "p1" },
      deps({ policy: { scriptTasksEnabled: false } })
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "script-tasks-disabled" })
  })

  it("counts the quota PER SOURCE, not across the whole schedule", async () => {
    const counted: string[] = []
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", sessionId: "s1" },
      {
        loadPolicy: async () => policy({ maxTasksPerSource: 3, agentAutoCreate: true }),
        countTasksBySource: async (source) => {
          counted.push(source)
          return 3
        },
      }
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "quota-exceeded" })
    // The old implementation counted every task regardless of author, so a
    // busy user locked their own agents out of a schedule they never touched.
    expect(counted).toEqual(["agent"])
  })

  it("lets an agent through when it is under the quota and auto-create is on", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", sessionId: "s1" },
      deps({ policy: { agentAutoCreate: true, maxTasksPerSource: 5 }, owned: 2 })
    )
    expect(verdict).toEqual({ allowed: true })
  })

  it("refuses an agent write when agentAutoCreate is off", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", sessionId: "s1" },
      deps({ policy: { agentAutoCreate: false } })
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "agent-auto-create-disabled" })
  })

  it("asks for confirmation rather than refusing, for a listed type", async () => {
    // The two settings answer different questions. `agentAutoCreate` is "may
    // they act unattended", `confirmationRequired` is "which kinds always need
    // me". If the refusal ran first the second list would be unreachable.
    const verdict = await authorizeTaskWrite(
      { taskType: "goal", source: "agent", sessionId: "s1" },
      deps({ policy: { agentAutoCreate: false, confirmationRequired: ["goal"] } })
    )
    expect(verdictNeedsConfirmation(verdict)).toBe(true)
    expect(verdict.allowed).toBe(true)
  })

  it("still asks for confirmation when auto-create is ON", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "goal", source: "agent", sessionId: "s1" },
      deps({ policy: { agentAutoCreate: true, confirmationRequired: ["goal"] } })
    )
    expect(verdictNeedsConfirmation(verdict)).toBe(true)
  })

  it("applies the quota before the confirmation question", async () => {
    // Otherwise a confirmation prompt appears for a write that would be
    // refused the moment the user approved it.
    const verdict = await authorizeTaskWrite(
      { taskType: "goal", source: "agent", sessionId: "s1" },
      deps({ policy: { confirmationRequired: ["goal"], maxTasksPerSource: 1 }, owned: 1 })
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "quota-exceeded" })
  })

  it("falls back to the restrictive defaults when nothing is stored", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", sessionId: "s1" },
      { loadPolicy: async () => DEFAULT_PERMISSION_POLICY, countTasksBySource: async () => 0 }
    )
    // `DEFAULT_PERMISSION_POLICY.agentAutoCreate` is false, so an unconfigured
    // install refuses rather than waving an agent write through.
    expect(verdict).toMatchObject({ allowed: false, reason: "agent-auto-create-disabled" })
  })
})

describe("authorizeTaskWrite · agent access and confirmation", () => {
  it("refuses every agent write while agents may not manage the schedule", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", humanConfirmed: true },
      deps({ policy: { agentToolsEnabled: false, agentAutoCreate: true } })
    )
    // Not even a confirmed write: the switch is the user's standing answer.
    expect(verdict).toMatchObject({ allowed: false, reason: "agent-tools-disabled" })
  })

  it("does not apply the agent switch to plugins or the user", async () => {
    const off = deps({ policy: { agentToolsEnabled: false, agentAutoCreate: true } })
    await expect(authorizeTaskWrite({ taskType: "chat", source: "plugin" }, off)).resolves.toEqual({
      allowed: true,
    })
    await expect(authorizeTaskWrite({ taskType: "chat", source: "user" }, off)).resolves.toEqual({
      allowed: true,
    })
  })

  it("treats an absent switch (a policy saved before it existed) as on", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", humanConfirmed: true },
      {
        loadPolicy: async () => ({ ...policy(), agentToolsEnabled: undefined }),
        countTasksBySource: async () => 0,
      }
    )
    expect(verdict).toEqual({ allowed: true })
  })

  it("lets a write the user confirmed through, with agentAutoCreate off", async () => {
    // agentAutoCreate answers "may agents act unattended"; a confirmed write is attended.
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", humanConfirmed: true },
      deps({ policy: { agentAutoCreate: false } })
    )
    expect(verdict).toEqual({ allowed: true })
  })

  it("does not ask twice for a confirmation-required type the user already confirmed", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "goal", source: "agent", humanConfirmed: true },
      deps({ policy: { confirmationRequired: ["goal"] } })
    )
    expect(verdict).toEqual({ allowed: true })
    expect(verdictNeedsConfirmation(verdict)).toBe(false)
  })

  it("still refuses an unattended agent write with agentAutoCreate off", async () => {
    const verdict = await authorizeTaskWrite(
      { taskType: "chat", source: "agent", humanConfirmed: false },
      deps({ policy: { agentAutoCreate: false } })
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "agent-auto-create-disabled" })
  })

  it("keeps the script switch and the quota for confirmed writes", async () => {
    await expect(
      authorizeTaskWrite(
        { taskType: "script", source: "agent", humanConfirmed: true },
        deps({ policy: { scriptTasksEnabled: false } })
      )
    ).resolves.toMatchObject({ allowed: false, reason: "script-tasks-disabled" })
    await expect(
      authorizeTaskWrite(
        { taskType: "chat", source: "agent", humanConfirmed: true },
        deps({ policy: { maxTasksPerSource: 2 }, owned: 2 })
      )
    ).resolves.toMatchObject({ allowed: false, reason: "quota-exceeded" })
  })

  it("scopes the quota to creation: an agent at its limit can still act on what it owns", async () => {
    const atLimit = deps({ policy: { maxTasksPerSource: 2, agentAutoCreate: true }, owned: 2 })
    await expect(
      authorizeTaskWrite({ taskType: "chat", source: "agent", operation: "mutate" }, atLimit)
    ).resolves.toEqual({ allowed: true })
    await expect(
      authorizeTaskWrite({ taskType: "chat", source: "agent", operation: "create" }, atLimit)
    ).resolves.toMatchObject({ allowed: false, reason: "quota-exceeded" })
    // Unspecified is a create, which is what every older caller meant.
    await expect(
      authorizeTaskWrite({ taskType: "chat", source: "agent" }, atLimit)
    ).resolves.toMatchObject({ allowed: false, reason: "quota-exceeded" })
  })

  it("still refuses a host that cannot run the type, confirmed or not", async () => {
    getTaskTypeHostSupport.mockReturnValue({
      supported: false,
      reason: "desktop-only",
      missing: ["shell"],
      requires: ["shell"],
    })
    const verdict = await authorizeTaskWrite(
      { taskType: "background-command", source: "agent", humanConfirmed: true },
      deps()
    )
    expect(verdict).toMatchObject({ allowed: false, reason: "unsupported-on-host" })
  })
})

describe("assertTaskWriteAllowed", () => {
  it("resolves for an allowed write", async () => {
    await expect(
      assertTaskWriteAllowed(
        { taskType: "chat", source: "agent" },
        deps({ policy: { agentAutoCreate: true } })
      )
    ).resolves.toBeUndefined()
  })

  it("treats a confirmation verdict as a refusal, and says where to go instead", async () => {
    // A caller with no way to ask the user must not decide on their behalf.
    await expect(
      assertTaskWriteAllowed(
        { taskType: "goal", source: "plugin", pluginId: "p1" },
        deps({ policy: { confirmationRequired: ["goal"] } })
      )
    ).rejects.toThrow(/scheduler panel/)
  })

  it("throws the refusal message for a denied write", async () => {
    await expect(
      assertTaskWriteAllowed(
        { taskType: "script", source: "plugin" },
        deps({ policy: { scriptTasksEnabled: false } })
      )
    ).rejects.toThrow(/turned off/)
  })
})
