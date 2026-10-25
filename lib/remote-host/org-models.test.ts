/** @jest-environment jsdom */
import { closeManagementChannel } from "@/lib/remote-host/management-channel"
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"

import {
  deleteOrgCredential,
  getOrgAgentPolicy,
  getOrgUsage,
  listOrgCredentials,
  orgModelsRefusal,
  setOrgAgentPolicy,
  setOrgCredential,
  setOrgDefaultCap,
  setOrgMemberCap,
  type OrgModelsDeps,
} from "./org-models"

const HOST = "org-models-test"
const call = jest.fn()

function deps(): OrgModelsDeps {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Org box" },
          transport: { call, subscribe: jest.fn(() => () => undefined) },
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
  }
}

beforeEach(() => call.mockReset())
afterEach(() => closeManagementChannel(HOST))

describe("organization models over the management channel", () => {
  it("lists credentials without naming the org, and tolerates an empty answer", async () => {
    const entry = { provider: "claude", fingerprint: "abc123abc123", setAt: 1, setBy: "usr_a" }
    call.mockResolvedValueOnce([entry])
    await expect(listOrgCredentials(HOST, deps())).resolves.toEqual([entry])
    // The Host binds the org to the signed-in person; the client never names it.
    expect(call).toHaveBeenCalledWith("org_model_credential_list", {})
    call.mockResolvedValueOnce(null)
    await expect(listOrgCredentials(HOST, deps())).resolves.toEqual([])
  })

  it("sends a trimmed key and carries no lease", async () => {
    call.mockResolvedValueOnce({ provider: "claude", fingerprint: "f", setAt: 2, setBy: "usr_a" })
    await setOrgCredential(HOST, { provider: " claude ", apiKey: "  sk-1 \n" }, deps())
    expect(call).toHaveBeenCalledWith("org_model_credential_set", {
      provider: "claude",
      apiKey: "sk-1",
    })
  })

  it("removes a credential by provider", async () => {
    call.mockResolvedValueOnce(undefined)
    await deleteOrgCredential(HOST, "codex", deps())
    expect(call).toHaveBeenCalledWith("org_model_credential_delete", { provider: "codex" })
  })

  it("reads and writes the agent policy, leaving out an absent default", async () => {
    const policy = { allowedAgents: [], bundledAgents: [], defaultAgent: null }
    call.mockResolvedValue(policy)
    await expect(getOrgAgentPolicy(HOST, deps())).resolves.toBe(policy)
    expect(call).toHaveBeenLastCalledWith("org_agent_policy_get", {})
    await setOrgAgentPolicy(HOST, { allowedAgents: [], defaultAgent: null }, deps())
    expect(call).toHaveBeenLastCalledWith("org_agent_policy_set", { allowedAgents: [] })
    await setOrgAgentPolicy(HOST, { allowedAgents: ["pi"], defaultAgent: "pi" }, deps())
    expect(call).toHaveBeenLastCalledWith("org_agent_policy_set", {
      allowedAgents: ["pi"],
      defaultAgent: "pi",
    })
  })

  it("reads the month's usage and tolerates a partial answer", async () => {
    const member = {
      userId: "usr_bob",
      // Carried through: the Host names members the org plane knows.
      displayName: "Bob",
      spentTokens: 10,
      reservedTokens: 2,
      monthlyTokens: null,
      capSource: "override",
    }
    call.mockResolvedValueOnce({ month: "2026-10", defaultMonthlyTokens: 1000, members: [member] })
    await expect(getOrgUsage(HOST, deps())).resolves.toEqual({
      month: "2026-10",
      defaultMonthlyTokens: 1000,
      members: [member],
    })
    expect(call).toHaveBeenLastCalledWith("org_member_usage_get", {})
    // A Host that could not list every member says so; only `true` counts.
    call.mockResolvedValueOnce({
      month: "2026-10",
      defaultMonthlyTokens: null,
      members: [],
      membersIncomplete: true,
    })
    await expect(getOrgUsage(HOST, deps())).resolves.toEqual({
      month: "2026-10",
      defaultMonthlyTokens: null,
      members: [],
      membersIncomplete: true,
    })
    call.mockResolvedValueOnce({
      month: "2026-10",
      defaultMonthlyTokens: null,
      members: [],
      membersIncomplete: "yes",
    })
    await expect(getOrgUsage(HOST, deps())).resolves.not.toHaveProperty("membersIncomplete")
    call.mockResolvedValueOnce(null)
    await expect(getOrgUsage(HOST, deps())).resolves.toEqual({
      month: "",
      defaultMonthlyTokens: null,
      members: [],
    })
  })

  it("sets the default and a person's cap, including no cap and back to the default", async () => {
    call.mockResolvedValue(null)
    await setOrgDefaultCap(HOST, 5000, deps())
    expect(call).toHaveBeenLastCalledWith("org_usage_cap_set", { defaultMonthlyTokens: 5000 })
    await setOrgDefaultCap(HOST, null, deps())
    expect(call).toHaveBeenLastCalledWith("org_usage_cap_set", { defaultMonthlyTokens: null })
    for (const cap of [42, null, "default"] as const) {
      await setOrgMemberCap(HOST, "usr_bob", cap, deps())
      expect(call).toHaveBeenLastCalledWith("org_member_usage_cap_set", {
        userId: "usr_bob",
        monthlyTokens: cap,
      })
    }
  })
})

describe("orgModelsRefusal", () => {
  it.each([
    [{ code: "org_scope_unavailable" }, "not-org-host"],
    [{ code: "host_surface_forbidden" }, "not-admin"],
    [{ code: "host_principal_unbound" }, "not-admin"],
    [new Error("host_surface_forbidden: org.policy.manage"), "not-admin"],
    ["org_scope_unavailable", "not-org-host"],
    [{ code: "timeout" }, null],
    [new Error("network down"), null],
    [null, null],
  ])("maps %p to %p", (error, expected) => {
    expect(orgModelsRefusal(error)).toBe(expected)
  })
})
