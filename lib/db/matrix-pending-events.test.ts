import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  MATRIX_PENDING_EVENT_CAP,
  MATRIX_RECOVERY_REQUIRED_ATTEMPTS,
  countMatrixRecoveryRequired,
  deleteMatrixPendingEvent,
  listRetryableMatrixPendingEvents,
  markMatrixPendingEventFailed,
  persistMatrixPendingEncryptedEvent,
} from "./matrix-pending-events"
import type { MatrixTimelineEvent } from "@/lib/connectors/adapters/matrix/parse"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function encryptedEvent(eventId: string): MatrixTimelineEvent {
  return {
    type: "m.room.encrypted",
    event_id: eventId,
    sender: "@alice:example.org",
    origin_server_ts: 1,
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "cipher" },
  }
}

describe("matrix pending encrypted events", () => {
  it("persists and deduplicates by adapter and Matrix event id", async () => {
    const first = await persistMatrixPendingEncryptedEvent({
      adapterId: "mx-1",
      roomId: "!room:example.org",
      event: encryptedEvent("$event"),
    })
    const second = await persistMatrixPendingEncryptedEvent({
      adapterId: "mx-1",
      roomId: "!room:example.org",
      event: encryptedEvent("$event"),
    })

    expect(first).toMatchObject({ ok: true, deduplicated: false })
    expect(second).toMatchObject({ ok: true, deduplicated: true })
    expect(await getDb().matrixPendingEncryptedEvents.count()).toBe(1)
  })

  it("moves repeatedly failing events to visible recovery_required state", async () => {
    const persisted = await persistMatrixPendingEncryptedEvent({
      adapterId: "mx-1",
      roomId: "!room:example.org",
      event: encryptedEvent("$late-key"),
    })
    if (!persisted.ok) throw new Error(persisted.reason)
    for (let attempt = 0; attempt < MATRIX_RECOVERY_REQUIRED_ATTEMPTS; attempt += 1) {
      await markMatrixPendingEventFailed(persisted.row.id, "missing room key")
    }

    expect(await countMatrixRecoveryRequired("mx-1")).toBe(1)
    expect(await listRetryableMatrixPendingEvents("mx-1", Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  it("lists due pending rows and deletes successful recoveries", async () => {
    const persisted = await persistMatrixPendingEncryptedEvent({
      adapterId: "mx-1",
      roomId: "!room:example.org",
      event: encryptedEvent("$recover"),
    })
    if (!persisted.ok) throw new Error(persisted.reason)

    expect(await listRetryableMatrixPendingEvents("mx-1", Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    await deleteMatrixPendingEvent(persisted.row.id)
    expect(await getDb().matrixPendingEncryptedEvents.get(persisted.row.id)).toBeUndefined()
  })

  it("refuses a new active row at the per-adapter capacity", async () => {
    const now = Date.now()
    await getDb().matrixPendingEncryptedEvents.bulkAdd(
      Array.from({ length: MATRIX_PENDING_EVENT_CAP }, (_, index) => ({
        id: `mx-cap\u0000$${index}`,
        adapterId: "mx-cap",
        eventId: `$${index}`,
        roomId: "!room:example.org",
        rawEvent: encryptedEvent(`$${index}`),
        attempts: 0,
        firstSeenAt: now,
        updatedAt: now,
        nextAttemptAt: now,
        state: index === 0 ? ("recovery_required" as const) : ("pending" as const),
      }))
    )

    await expect(
      persistMatrixPendingEncryptedEvent({
        adapterId: "mx-cap",
        roomId: "!room:example.org",
        event: encryptedEvent("$overflow"),
      })
    ).resolves.toEqual({ ok: false, reason: "capacity" })
  })
})
