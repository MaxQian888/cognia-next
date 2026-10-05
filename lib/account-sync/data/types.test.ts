import { TABLE_POLICIES } from "./tables"
import type {
  AccountSyncCaptureState,
  AccountSyncCursorState,
  AccountSyncInboxRow,
  AccountSyncOutboxRow,
  AccountSyncStateRow,
  SyncFieldClocksRow,
  SyncedTableName,
} from "./types"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const exact = <T extends true>(value: T) => value

describe("account sync row types", () => {
  it("name exactly the tables the policies cover", () => {
    exact<Equal<SyncedTableName, keyof typeof TABLE_POLICIES>>(true)
    expect(Object.keys(TABLE_POLICIES).sort()).toEqual([
      "characters",
      "memories",
      "messages",
      "sessions",
      "settings",
      "skills",
    ] satisfies SyncedTableName[])
  })

  it("tell the two state rows apart by id", () => {
    const rows: AccountSyncStateRow[] = [
      {
        id: "capture",
        spaceId: "s",
        deviceId: "d",
        classes: { content: true, settings: false },
        hlc: null,
      } satisfies AccountSyncCaptureState,
      { id: "cursor", spaceId: "s", serverSeq: 3, deviceSeq: 2 } satisfies AccountSyncCursorState,
    ]
    const cursor = rows.find((row): row is AccountSyncCursorState => row.id === "cursor")
    expect(cursor?.serverSeq).toBe(3)
  })

  it("describe the outbox, clock and inbox rows the engine stores", () => {
    const outbox: AccountSyncOutboxRow = {
      table: "settings",
      rowId: "profile",
      fields: ["value"],
      deleted: false,
      rev: 1,
      since: 0,
    }
    const clocks: SyncFieldClocksRow = {
      table: "sessions",
      rowId: "s1",
      fields: {},
      tombstone: "t",
      unknown: { later: [1, "t"] },
    }
    const parked: AccountSyncInboxRow["reason"][] = ["schema", "key"]
    expect([outbox.rowId, clocks.tombstone, parked]).toEqual(["profile", "t", ["schema", "key"]])
  })
})
