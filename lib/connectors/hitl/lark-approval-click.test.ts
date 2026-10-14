/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "@/lib/connectors/bus"
import { __resetPruneCounterForTesting } from "@/lib/connectors/dedup"
import {
  recordCallbackBinding,
  resolveCallbackBinding,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { buildLarkA2UICard } from "@/lib/connectors/adapters/lark/card"
import {
  parseLarkInteractiveCallback,
  type LarkEventEnvelope,
} from "@/lib/connectors/adapters/lark/parse"
import { buildToolApprovalSurface } from "./tool-approval"
import {
  awaitApproval,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
} from "./approval-registry"

beforeEach(async () => {
  __resetApprovalRegistryForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  await getDb().delete()
  __resetDbForTesting()
}, 30_000)

afterEach(() => {
  __resetApprovalRegistryForTesting()
  __resetBusForTesting()
})

it.each([
  [0, "allow", "allow", "approve"],
  [1, "deny", "deny", "cancel"],
  [2, "allowSession", "allow_session", "approve"],
] as const)(
  "routes emitted button %s through the bus tool_approve branch",
  async (index, componentId, decision, action) => {
    const adapter = await createAdapterInstance({
      type: "lark",
      displayName: "Approval Bot",
      enabled: true,
      transportMode: "gateway",
      settings: { larkPrincipalRegistry: false, larkStrictCallbackAuthorization: "enforce" },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
    })
    const surface = buildToolApprovalSurface({ bindingId: "request", toolName: "Bash" })
    const actionId = (surface.components[componentId] as { value: string }).value
    const conversationKey = `lark:${adapter.id}:chat`
    await recordCallbackBinding({
      adapterId: adapter.id,
      actionId,
      surfaceId: "approval",
      componentId,
      conversationKey,
      kind: "tool_approve",
      allowedActions: [action],
      actorScope: { mode: "initiator", allowedUserIds: ["user"] },
      payload: { sessionId: "session", requestId: "request", toolName: "Bash", decision },
    })
    const body = await buildLarkA2UICard({
      adapterId: adapter.id,
      surfaceId: "approval",
      surface,
      conversationKey,
    })
    const card = JSON.parse(body.content)
    const row = card.body.elements.find((element: { tag: string }) => element.tag === "column_set")
    const value = row.columns[index].elements[0].behaviors[0].value
    const callback = parseLarkInteractiveCallback(adapter.id, "bot", {
      schema: "2.0",
      header: { event_type: "card.action.trigger", event_id: "event" },
      event: {
        operator: { open_id: "user" },
        action: { tag: "button", value },
        context: { open_message_id: "message", open_chat_id: "chat" },
      } as unknown as LarkEventEnvelope["event"],
    })!
    expect(callback).toMatchObject({ triggerId: actionId, value: action })
    expect(await resolveCallbackBinding(adapter.id, callback.triggerId)).toMatchObject({
      kind: "tool_approve",
    })
    expect(await getDb().connectorCallbackBindings.count()).toBe(1)
    const pending = awaitApproval("session", "request", { ttlMs: 0 })
    const bus = getBus()
    bus.routeHandler = jest.fn()
    expect(await bus.dispatchConnectorCallback(callback)).toBe("terminal")
    expect(pendingApprovalCount()).toBe(0)
    await expect(pending).resolves.toEqual({ decision: decision === "deny" ? "deny" : "allow" })
    expect(bus.routeHandler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: decision === "deny" ? "tool_approve.denied" : "tool_approve.granted",
          fields: expect.objectContaining({ resolved: true }),
        }),
      ])
    )
    expect(audit.some((entry) => entry.kind === "callback.unbound")).toBe(false)
  }
)
