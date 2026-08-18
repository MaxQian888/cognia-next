/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie `delete()` + `open()` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

jest.mock("@/lib/connectors/delivery-gateway", () => ({ enqueueGoverned: jest.fn() }))
jest.mock("@/lib/sync/host-invalidate", () => ({ publishSyncInvalidate: jest.fn() }))

import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { getDb } from "@/lib/db/schema"
import { createDraft } from "@/lib/db/connector-drafts"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import { readForResolution, upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { INBOX_RELAY_HOST_OPERATIONS } from "@/lib/platform/host-feature-manifest"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { ConversationReference } from "@/types/connectors/event"

import {
  InboxWriteUnavailableError,
  approveInboxDraft,
  mutateConversationOverride,
  rejectInboxDraft,
  sendManualReply,
} from "./index"
import { __setInboxWriteRouteDepsForTests } from "./route"

const enqueueMock = enqueueGoverned as jest.Mock

const ADAPTER = "tg-1"
const KEY = "telegram:tg-1:555"
const SESSION = "s-1"
const REF: ConversationReference = { platform: "telegram", adapterId: ADAPTER }

let restoreRoute: () => void = () => undefined
let jobSeq = 0

/** Route this shell as a local connector host. */
function asLocalHost(): void {
  restoreRoute = __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasConnectorRuntime: () => true,
    getRuntimeSnapshot: () => ({ target: null, vaultState: "unlocked", connectionState: "online" }),
    activeHostFeatureManifest: () => null,
  })
}

/** Route this shell as a paired thin client. */
function asThinClient(operations: readonly string[] = INBOX_RELAY_HOST_OPERATIONS): void {
  const snapshot: RuntimeSnapshot = {
    target: { kind: "companion", id: "host-1" } as RuntimeSnapshot["target"],
    vaultState: "unlocked",
    connectionState: "online",
    host: { compatible: true, operations, grants: ["workspace.write"] },
  }
  restoreRoute = __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasConnectorRuntime: () => false,
    getRuntimeSnapshot: () => snapshot,
    activeHostFeatureManifest: () => null,
  })
}

/** Route this shell as a standalone browser / unpaired phone. */
function asStandalone(): void {
  restoreRoute = __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasConnectorRuntime: () => false,
    getRuntimeSnapshot: () => ({ target: null, vaultState: "unlocked", connectionState: "online" }),
    activeHostFeatureManifest: () => null,
  })
}

beforeEach(async () => {
  jest.clearAllMocks()
  jobSeq = 0
  setActiveRuntimeTargetContext("acct-1", "host-1")
  await getDb().delete()
  await getDb().open()
  enqueueMock.mockImplementation(async (input: Record<string, never>) => {
    const now = Date.now()
    const row = {
      ...(input as unknown as OutboundJobRow),
      id: `job-${++jobSeq}`,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: 0,
      idempotencyKey: (input as unknown as OutboundJobRow).request.metadata.idempotencyKey,
    } as OutboundJobRow
    await getDb().outboundQueue.add(row)
    return row
  })
})

afterEach(() => {
  restoreRoute()
  clearActiveRuntimeTargetContext()
})

const sendInput = {
  adapterId: ADAPTER,
  conversationKey: KEY,
  sessionId: SESSION,
  conversationRef: REF,
  text: "  on it  ",
}

describe("sendManualReply", () => {
  it("executes locally on a connector host and reports the route", async () => {
    asLocalHost()
    const outcome = await sendManualReply(sendInput)

    expect(outcome.route).toBe("local")
    expect(outcome.jobId).toBeDefined()
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    // Free text is trimmed into a single text segment.
    expect(enqueueMock.mock.calls[0][0].request.segments).toEqual([{ type: "text", text: "on it" }])
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })

  it("relays through the durable queue on a thin client", async () => {
    asThinClient()
    const outcome = await sendManualReply(sendInput)

    expect(outcome.route).toBe("remote")
    // The host allocates the job; the client only knows the relay key.
    expect(outcome.jobId).toBeUndefined()
    expect(enqueueMock).not.toHaveBeenCalled()
    const [row] = await getDb().mobileOutboundQueue.toArray()
    expect(row.command).toBe("connector_enqueue_outbound")
    expect(row.idempotencyKey).toBe(outcome.idempotencyKey)
  })

  it("mints one idempotency key and threads it everywhere", async () => {
    asLocalHost()
    const outcome = await sendManualReply(sendInput)
    expect(outcome.idempotencyKey).toEqual(expect.any(String))
    expect(enqueueMock.mock.calls[0][0].request.metadata.idempotencyKey).toBe(
      outcome.idempotencyKey
    )
  })

  it("honours a caller-supplied key so a retry replays instead of double-sending", async () => {
    asLocalHost()
    const first = await sendManualReply({ ...sendInput, idempotencyKey: "fixed" })
    const second = await sendManualReply({ ...sendInput, idempotencyKey: "fixed" })

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(second.jobId).toBe(first.jobId)
    expect(second.reused).toBe(true)
  })

  it("prefers explicit segments over text", async () => {
    asLocalHost()
    await sendManualReply({
      ...sendInput,
      segments: [{ type: "image", url: "https://x/i.png" }],
    })
    expect(enqueueMock.mock.calls[0][0].request.segments).toEqual([
      { type: "image", url: "https://x/i.png" },
    ])
  })

  it("throws a typed error standalone, before any row is written", async () => {
    asStandalone()
    await expect(sendManualReply(sendInput)).rejects.toBeInstanceOf(InboxWriteUnavailableError)
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("fails fast against a host that predates the relay rather than dead-lettering", async () => {
    asThinClient(["connector_approve_draft"])
    const error = await sendManualReply(sendInput).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboxWriteUnavailableError)
    expect((error as InboxWriteUnavailableError).command).toBe("connector_enqueue_outbound")
    expect((error as InboxWriteUnavailableError).availability.reason).toBe("operation-unavailable")
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })
})

describe("approveInboxDraft / rejectInboxDraft", () => {
  async function seedDraft() {
    return createDraft({
      sessionId: SESSION,
      conversationKey: KEY,
      segments: [{ type: "text", text: "draft" }],
    })
  }

  it("accepts a row or a bare id", async () => {
    asThinClient()
    const draft = await seedDraft()
    expect((await approveInboxDraft(draft)).draftId).toBe(draft.id)
    expect((await rejectInboxDraft(draft.id)).draftId).toBe(draft.id)
  })

  it("approves locally with edited segments", async () => {
    asLocalHost()
    const draft = await seedDraft()
    const outcome = await approveInboxDraft(draft.id, {
      segments: [{ type: "text", text: "edited" }],
      binding: { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF },
    })
    expect(outcome.route).toBe("local")
    expect(enqueueMock.mock.calls[0][0].request.segments).toEqual([
      { type: "text", text: "edited" },
    ])
  })

  it("relays the approval on a thin client", async () => {
    asThinClient()
    const draft = await seedDraft()
    const outcome = await approveInboxDraft(draft.id)
    expect(outcome.route).toBe("remote")
    expect(outcome.jobId).toBeUndefined()
    const [row] = await getDb().mobileOutboundQueue.toArray()
    expect(row.command).toBe("connector_approve_draft")
  })

  it("refuses both writes standalone", async () => {
    asStandalone()
    await expect(approveInboxDraft("d-1")).rejects.toBeInstanceOf(InboxWriteUnavailableError)
    await expect(rejectInboxDraft("d-1")).rejects.toBeInstanceOf(InboxWriteUnavailableError)
  })
})

describe("mutateConversationOverride", () => {
  beforeEach(async () => {
    await upsertByConversationKey({ conversationKey: KEY, sessionId: SESSION })
  })

  it("applies with full semantics on a local host", async () => {
    asLocalHost()
    const outcome = await mutateConversationOverride(
      { kind: "setAssignee", conversationKey: KEY, assignee: { kind: "human", id: "u1" } },
      { via: "operator" }
    )
    expect(outcome).toEqual({ route: "local", conversationKey: KEY })
    expect((await readForResolution(KEY))?.assignee).toEqual({ kind: "human", id: "u1" })
    expect(await getDb().conversationAssignmentEvents.count()).toBe(1)
  })

  it("relays + mirrors optimistically on a thin client", async () => {
    asThinClient()
    const outcome = await mutateConversationOverride({
      kind: "setPinned",
      conversationKey: KEY,
      pinned: true,
    })
    expect(outcome.route).toBe("remote")
    expect((await readForResolution(KEY))?.pinned).toBe(true)
    const [row] = await getDb().mobileOutboundQueue.toArray()
    expect(row.command).toBe("conversation_overrides_update")
    // No trail on the client — the host is authoritative for provenance.
    expect(await getDb().conversationAssignmentEvents.count()).toBe(0)
  })

  it("refuses standalone without touching the mirror", async () => {
    asStandalone()
    await expect(
      mutateConversationOverride({ kind: "setPinned", conversationKey: KEY, pinned: true })
    ).rejects.toBeInstanceOf(InboxWriteUnavailableError)
    expect((await readForResolution(KEY))?.pinned).toBeUndefined()
  })
})

describe("InboxWriteUnavailableError", () => {
  it("carries the command, route and availability for the UI to explain itself", () => {
    const error = new InboxWriteUnavailableError("connector_enqueue_outbound", "unavailable", {
      state: "unsupported",
      reason: "requires-companion",
    })
    expect(error.code).toBe("inbox_write_unavailable")
    expect(error.name).toBe("InboxWriteUnavailableError")
    expect(error.message).toContain("connector_enqueue_outbound")
    expect(error.message).toContain("requires-companion")
  })
})
