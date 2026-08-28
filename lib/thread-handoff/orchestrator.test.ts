/** @jest-environment jsdom */

import type { ChatSession } from "@cognia/agent-config-types"
import { validateThreadHandoffRefs } from "@cognia/agent-config-types/thread-handoff"

import { buildThreadHandoffOffer, recoverThreadHandoffOffer } from "./orchestrator"

const session: ChatSession = {
  id: "session-1",
  title: "Portable session",
  projectId: "workspace-1",
  providerOverride: "anthropic",
  model: "claude-sonnet",
  sdkSessionId: "native-session",
  permissionMode: "default",
  workingDir: "/Users/alice/private/project",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
}

describe("buildThreadHandoffOffer", () => {
  it("projects a canonical, path-free ticket with provider and credential requirements", async () => {
    const frame = await buildThreadHandoffOffer(
      session,
      { hostRef: "phone-1", kind: "mobile", label: "Phone" },
      1_700_000_002_000,
      {
        ticketId: "ticket-1",
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
        ] as never,
        deployments: [
          {
            id: "anthropic",
            providerRef: "provider-anthropic",
            endpoint: "https://api.anthropic.com",
            transportProfileRef: "transport-anthropic",
            legacyProviderId: "anthropic",
            credentialProfileRef: {
              kind: "legacy-provider-settings",
              providerId: "anthropic",
            },
            models: [{ id: "claude-sonnet" }],
          },
        ],
      }
    )

    expect(frame.ticket.requirements).toMatchObject({
      capabilities: ["thread-handoff-v1"],
      providerRefs: ["provider-anthropic", "anthropic"],
      models: ["claude-sonnet"],
      credentialProfileRefs: ["legacy-provider-settings:anthropic"],
    })
    expect(frame.envelope.turns.map((turn) => turn.text)).toEqual(["Hello", "Hi"])
    expect(frame.ticket.continuation.sequenceDigest).toBe(frame.envelope.header.sequenceDigest)
    expect(validateThreadHandoffRefs(frame.ticket)).toEqual([])
    expect(JSON.stringify(frame)).not.toContain(session.workingDir)
  })

  it("requires no provider when the session pinned neither a model nor an override", async () => {
    // `upstreamId` / `canonicalModelRef` are optional, so an unset
    // `session.model` used to `.includes(undefined)` its way into the first
    // deployment missing either — and the ticket then demanded a provider and
    // credential this session never used, which the target refuses.
    const unpinned: ChatSession = {
      ...session,
      model: undefined,
      providerOverride: undefined,
    }
    const frame = await buildThreadHandoffOffer(
      unpinned,
      { hostRef: "phone-1", kind: "mobile", label: "Phone" },
      1_700_000_002_000,
      {
        ticketId: "ticket-2",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] }] as never,
        deployments: [
          {
            id: "anthropic",
            providerRef: "provider-anthropic",
            endpoint: "https://api.anthropic.com",
            transportProfileRef: "transport-anthropic",
            legacyProviderId: "anthropic",
            credentialProfileRef: {
              kind: "legacy-provider-settings",
              providerId: "anthropic",
            },
            // No `upstreamId`, no `canonicalModelRef` — the shape that matched.
            models: [{ id: "claude-sonnet" }],
          },
        ],
      }
    )

    expect(frame.ticket.requirements.providerRefs).toEqual([])
    expect(frame.ticket.requirements.credentialProfileRefs).toEqual([])
    expect(frame.ticket.requirements.models).toEqual([])
  })

  it("rejects recovery unless the persisted source ticket is frozen and owns the session lock", async () => {
    await expect(
      recoverThreadHandoffOffer(session, {
        ticketVersion: 1,
        ticketId: "ticket-1",
        state: "preparing",
        role: "source",
        source: {
          hostRef: "local",
          kind: "desktop",
          sessionId: session.id,
          title: session.title,
          messageCount: 0,
        },
        target: { hostRef: "phone-1", kind: "mobile", label: "Phone" },
        transport: "companion",
        project: {},
        requirements: {
          capabilities: ["thread-handoff-v1"],
          hostOperations: [],
          providerRefs: [],
          models: [],
          credentialProfileRefs: [],
          minProtocolVersion: 1,
        },
        continuation: {
          sourceRuntime: "cognia",
          fidelity: "structured",
          sequenceDigest: "digest",
        },
        attachments: [],
        pendingApprovals: [],
        history: [],
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      })
    ).rejects.toThrow("thread_handoff_offer_not_recoverable")
  })
})
