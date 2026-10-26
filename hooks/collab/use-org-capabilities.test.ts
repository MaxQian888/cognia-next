/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import { CollabError } from "@/lib/collab/client"
import { parseOrgCapabilities, type OrgCapabilitiesResult } from "@/lib/collab/capabilities"
import { notifyCollabScopeChanged } from "@/lib/collab/scope-events"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import {
  ORG_CAPABILITIES_FRESH_MS,
  __resetOrgCapabilitiesCacheForTesting,
  useOrgCapabilities,
  type UseOrgCapabilitiesDeps,
} from "./use-org-capabilities"

function contextFor(orgId: string, userId = "usr_ada"): CurrentCollabContext {
  return {
    localAccountId: "acct_a",
    orgId,
    userId,
    client: { baseUrl: "https://collab.example" } as CurrentCollabContext["client"],
  }
}

function ready(orgId: string, workspaceId: string | null, role = "member"): OrgCapabilitiesResult {
  return {
    status: "ready",
    capabilities: parseOrgCapabilities(
      {
        schemaVersion: 1,
        orgId,
        workspaceId,
        standing: { orgRole: role, workspaceRole: "member", via: "membership", guest: false },
        actions: ["workspace.read"],
        features: [{ key: "shared-chat", state: "available", reason: null, policyRevision: 1 }],
        evaluatedAt: 1,
      },
      { orgId, workspaceId }
    ),
  }
}

beforeEach(() => {
  __resetOrgCapabilitiesCacheForTesting()
})

describe("useOrgCapabilities", () => {
  it("reports not-configured when there is no collaboration context", async () => {
    const deps: UseOrgCapabilitiesDeps = { resolveContext: async () => null }
    const { result } = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "unavailable", reason: "not-configured" })
    )
  })

  it("loads the answer for the current scope", async () => {
    const fetch = jest.fn(async () => ready("org_a", "ws_1"))
    const deps: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch,
    }
    const { result } = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetch).toHaveBeenCalledWith(expect.anything(), { orgId: "org_a", workspaceId: "ws_1" })
  })

  it("maps a 401 to not-signed-in and other failures to error", async () => {
    const signedOut: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch: async () => {
        throw new CollabError(401, "not signed in")
      },
    }
    const first = renderHook(() => useOrgCapabilities(null, signedOut))
    await waitFor(() =>
      expect(first.result.current).toMatchObject({
        status: "unavailable",
        reason: "not-signed-in",
      })
    )

    __resetOrgCapabilitiesCacheForTesting()
    const broken: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch: async () => {
        throw new Error("boom")
      },
    }
    const second = renderHook(() => useOrgCapabilities(null, broken))
    await waitFor(() =>
      expect(second.result.current).toMatchObject({ status: "error", message: "boom" })
    )
  })

  it("shares one request between components and reuses a fresh answer", async () => {
    const fetch = jest.fn(async () => ready("org_a", "ws_1"))
    const deps: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch,
    }
    const one = renderHook(() => useOrgCapabilities("ws_1", deps))
    const two = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(one.result.current.status).toBe("ready"))
    await waitFor(() => expect(two.result.current.status).toBe("ready"))
    expect(fetch).toHaveBeenCalledTimes(1)

    const three = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(three.result.current.status).toBe("ready"))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("asks again on refresh and once the cached answer is stale", async () => {
    let clock = 1_000
    const fetch = jest.fn(async () => ready("org_a", "ws_1"))
    const deps: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch,
      now: () => clock,
    }
    const { result } = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetch).toHaveBeenCalledTimes(1)

    act(() => result.current.refresh())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    clock += ORG_CAPABILITIES_FRESH_MS + 1
    const later = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(later.result.current.status).toBe("ready")
  })

  it("re-resolves the scope after an org switch and never shows the old org's answer", async () => {
    let orgId = "org_a"
    let releaseOld: (value: OrgCapabilitiesResult) => void = () => {}
    const fetch = jest.fn(
      (_client: unknown, input: { orgId: string; workspaceId?: string | null }) =>
        input.orgId === "org_a"
          ? new Promise<OrgCapabilitiesResult>((resolve) => {
              releaseOld = resolve
            })
          : Promise.resolve(ready("org_b", null, "admin"))
    )
    const deps: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor(orgId),
      fetch: fetch as unknown as UseOrgCapabilitiesDeps["fetch"],
    }
    const { result } = renderHook(() => useOrgCapabilities(null, deps))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    orgId = "org_b"
    act(() => notifyCollabScopeChanged())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.status === "ready" && result.current.capabilities.orgId).toBe("org_b")

    // The old org's answer lands late and must not replace the new one.
    await act(async () => releaseOld(ready("org_a", null)))
    expect(result.current.status === "ready" && result.current.capabilities.orgId).toBe("org_b")
  })

  it("keeps a cached answer on screen when a refresh fails", async () => {
    let fail = false
    const fetch = jest.fn(async () => {
      if (fail) throw new Error("offline")
      return ready("org_a", "ws_1")
    })
    const deps: UseOrgCapabilitiesDeps = {
      resolveContext: async () => contextFor("org_a"),
      fetch,
    }
    const { result } = renderHook(() => useOrgCapabilities("ws_1", deps))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    fail = true
    act(() => result.current.refresh())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(result.current.status).toBe("ready")
  })
})
