/** @jest-environment jsdom */
import { closeManagementChannel } from "@/lib/remote-host/management-channel"
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"

import {
  deleteOrgCredential,
  getOrgAgentPolicy,
  listOrgCredentials,
  orgModelsRefusal,
  setOrgAgentPolicy,
  setOrgCredential,
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
