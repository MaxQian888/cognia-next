import {
  formatHistoryLines,
  loadHistoryForPrompt,
  recordTurn,
  type PetHistoryDeps,
} from "./history"
import type { PetConversationRow } from "@/types/pet"

function makeDeps(rows: PetConversationRow[] = []): PetHistoryDeps & {
  appended: PetConversationRow[]
} {
  const appended: PetConversationRow[] = []
  return {
    appended,
    append: async (row) => {
      appended.push(row)
    },
    listRecent: async (limit) => rows.slice(-limit),
  }
}

describe("recordTurn", () => {
  it("writes one row through the injected append", async () => {
    const deps = makeDeps()
    await recordTurn(deps, { userText: "hi", reply: "hello!", at: 42 })
    expect(deps.appended).toEqual([{ at: 42, userText: "hi", reply: "hello!" }])
  })

  it("swallows append failures (history must never break speak)", async () => {
    const deps: PetHistoryDeps = {
      append: async () => {
        throw new Error("disk full")
      },
      listRecent: async () => [],
    }
    await expect(recordTurn(deps, { userText: "a", reply: "b", at: 1 })).resolves.toBeUndefined()
  })
})

describe("loadHistoryForPrompt", () => {
  it("returns the most recent turns, newest last, default limit 12", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      at: i,
      userText: `u${i}`,
      reply: `r${i}`,
    }))
    const deps = makeDeps(rows)
    const turns = await loadHistoryForPrompt(deps)
    expect(turns).toHaveLength(12)
    expect(turns[turns.length - 1].userText).toBe("u19")
  })

  it("honors an explicit limit and returns [] on a throwing reader", async () => {
    const deps = makeDeps([{ at: 1, userText: "a", reply: "b" }])
    expect(await loadHistoryForPrompt(deps, { limit: 1 })).toHaveLength(1)

    const broken: PetHistoryDeps = {
      append: async () => {},
      listRecent: async () => {
        throw new Error("boom")
      },
    }
    expect(await loadHistoryForPrompt(broken)).toEqual([])
  })
})

describe("formatHistoryLines", () => {
  it("renders alternating user/pet lines", () => {
    const text = formatHistoryLines([
      { at: 1, userText: "hi", reply: "hey!" },
      { at: 2, userText: "play?", reply: "sure" },
    ])
    expect(text).toBe("User: hi\nYou: hey!\nUser: play?\nYou: sure")
  })

  it("returns an empty string for no history", () => {
    expect(formatHistoryLines([])).toBe("")
  })
})

describe("the PII gate on replayed history", () => {
  const turn = (userText: string, reply: string) => ({ id: "pc_1", at: 1, userText, reply })

  it("drops a turn whose stored REPLY carries PII", () => {
    // The reply was never gated when it was written, and the TTS path refuses
    // that same string on the premise that a model can echo back a recalled
    // fact. Replaying it into the next prompt let the fact back out.
    const lines = formatHistoryLines([
      turn("what do you remember?", "your SSN is 123-45-6789"),
      turn("hello", "hi there!"),
    ])
    expect(lines).not.toContain("123-45-6789")
    expect(lines).toContain("hi there!")
  })

  it("drops a turn whose stored user text carries PII", () => {
    const lines = formatHistoryLines([turn("SSN 123-45-6789", "noted")])
    expect(lines).toBe("")
  })

  it("keeps an ordinary exchange intact", () => {
    expect(formatHistoryLines([turn("hey", "hey yourself")])).toBe("User: hey\nYou: hey yourself")
  })
})
