/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  PET_CONVERSATION_CAP,
  appendPetTurn,
  clearPetConversation,
  listRecentPetTurns,
} from "./pet-conversation"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().petConversationV2.clear()
})

describe("pet-conversation", () => {
  it("appends turns and lists them newest-last up to the limit", async () => {
    await appendPetTurn({ at: 1000, userText: "hi", reply: "hey!" })
    await appendPetTurn({ at: 2000, userText: "how are you", reply: "great" })
    await appendPetTurn({ at: 3000, userText: "play?", reply: "yes!" })

    const recent = await listRecentPetTurns(2)
    expect(recent.map((r) => r.at)).toEqual([2000, 3000])
    expect(recent[1]).toMatchObject({ userText: "play?", reply: "yes!" })
  })

  it("returns an empty list when there is no history", async () => {
    expect(await listRecentPetTurns(10)).toEqual([])
  })

  it("prunes the oldest rows beyond the cap on append", async () => {
    for (let i = 0; i < PET_CONVERSATION_CAP + 5; i++) {
      await appendPetTurn({ at: i, userText: `u${i}`, reply: `r${i}` })
    }
    const db = getDb()
    expect(await db.petConversationV2.count()).toBe(PET_CONVERSATION_CAP)
    // The survivors are the newest CAP rows.
    const oldest = await db.petConversationV2.orderBy("at").first()
    expect(oldest?.at).toBe(5)
  })

  it("clearPetConversation empties the table", async () => {
    await appendPetTurn({ at: 1, userText: "a", reply: "b" })
    await clearPetConversation()
    expect(await getDb().petConversationV2.count()).toBe(0)
  })
})

describe("the minted primary key", () => {
  it("returns a string id and stores it on the row", async () => {
    // Not an auto-increment number any more. The encryption middleware
    // requires a primary key to exist BEFORE the row is written, and an
    // auto-increment key does not exist until Dexie has written it, so every
    // append against the encrypted table would have thrown.
    const id = await appendPetTurn({ at: 1, userText: "hi", reply: "hello" })
    expect(typeof id).toBe("string")
    expect(id).toMatch(/^pc_/)
    const [row] = await listRecentPetTurns(1)
    expect(row.id).toBe(id)
  })

  it("mints a distinct id per turn so one cannot overwrite another", async () => {
    const ids = await Promise.all([
      appendPetTurn({ at: 1, userText: "a", reply: "1" }),
      appendPetTurn({ at: 2, userText: "b", reply: "2" }),
      appendPetTurn({ at: 3, userText: "c", reply: "3" }),
    ])
    expect(new Set(ids).size).toBe(3)
    expect(await listRecentPetTurns(10)).toHaveLength(3)
  })
})
