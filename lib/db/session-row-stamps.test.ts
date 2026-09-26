import { stampOrganizationalWrite } from "./session-row-stamps"

describe("stampOrganizationalWrite", () => {
  it("moves the sync cursor and pins the display recency it had", () => {
    const row: { lastMessageAt?: number; updatedAt: number } = { updatedAt: 10 }
    stampOrganizationalWrite(row, 99)
    expect(row).toEqual({ lastMessageAt: 10, updatedAt: 99 })
  })

  it("keeps a message timestamp that is already the recency key", () => {
    const row = { lastMessageAt: 5, updatedAt: 10 }
    stampOrganizationalWrite(row, 99)
    expect(row).toEqual({ lastMessageAt: 5, updatedAt: 99 })
  })

  it("is stable when repeated: the recency key is set once", () => {
    const row: { lastMessageAt?: number; updatedAt: number } = { updatedAt: 10 }
    stampOrganizationalWrite(row, 20)
    stampOrganizationalWrite(row, 30)
    expect(row).toEqual({ lastMessageAt: 10, updatedAt: 30 })
  })
})
