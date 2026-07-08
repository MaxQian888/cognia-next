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
  await getDb().petConversation.clear()
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
    expect(await db.petConversation.count()).toBe(PET_CONVERSATION_CAP)
    // The survivors are the newest CAP rows.
    const oldest = await db.petConversation.orderBy("at").first()
    expect(oldest?.at).toBe(5)
  })

  it("clearPetConversation empties the table", async () => {
    await appendPetTurn({ at: 1, userText: "a", reply: "b" })
    await clearPetConversation()
    expect(await getDb().petConversation.count()).toBe(0)
  })
})
