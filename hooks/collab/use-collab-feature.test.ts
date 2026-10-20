/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

import { parseOrgCapabilities } from "@/lib/collab/capabilities"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import { collabFeatureGate, useCollabFeature } from "./use-collab-feature"
import { __resetOrgCapabilitiesCacheForTesting } from "./use-org-capabilities"

const decision = (state: "available" | "existing-only" | "read-only" | "off") => ({
  key: "shared-chat" as const,
  state,
  reason: state === "available" ? null : ("feature_paused" as const),
  policyRevision: 1,
})

describe("collabFeatureGate", () => {
  it("defers to the caller's own gates when the server has not decided", () => {
    expect(collabFeatureGate(null)).toEqual({
      known: false,
      decision: null,
      canStart: true,
      canMutate: true,
      canRead: true,
    })
  })

  it.each([
    ["available", true, true, true],
    ["existing-only", false, true, true],
    ["read-only", false, false, true],
    ["off", false, false, false],
  ] as const)("%s narrows to start=%s mutate=%s read=%s", (state, start, mutate, read) => {
    const gate = collabFeatureGate(decision(state))
    expect(gate).toMatchObject({ known: true, canStart: start, canMutate: mutate, canRead: read })
  })
})

describe("useCollabFeature", () => {
  beforeEach(() => __resetOrgCapabilitiesCacheForTesting())

  it("reads the named feature from the scope's capabilities", async () => {
    const context = {
      localAccountId: "acct",
      orgId: "org_a",
      userId: "usr_ada",
      client: { baseUrl: "https://c" },
    } as unknown as CurrentCollabContext
    const { result } = renderHook(() =>
      useCollabFeature("shared-chat-execution", "ws_1", {
        resolveContext: async () => context,
        fetch: async () => ({
          status: "ready",
          capabilities: parseOrgCapabilities(
            {
              schemaVersion: 1,
              orgId: "org_a",
              workspaceId: "ws_1",
              standing: {},
              actions: [],
              features: [
                {
                  key: "shared-chat-execution",
                  state: "read-only",
                  reason: "feature_killed",
                  policyRevision: 2,
                },
              ],
              evaluatedAt: 1,
            },
            { orgId: "org_a", workspaceId: "ws_1" }
          ),
        }),
      })
    )
    expect(result.current.known).toBe(false)
    await waitFor(() => expect(result.current.known).toBe(true))
    expect(result.current.canStart).toBe(false)
    expect(result.current.decision?.reason).toBe("feature_killed")
  })
})
