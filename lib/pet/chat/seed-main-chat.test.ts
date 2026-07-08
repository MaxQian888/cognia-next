import { seedMainChat } from "./seed-main-chat"

describe("seedMainChat", () => {
  it("creates a session, seeds the trimmed draft, activates it, and returns the id", async () => {
    const createSession = jest.fn(() => ({ id: "s1" }))
    const setActiveSession = jest.fn()
    const setDraft = jest.fn().mockResolvedValue(undefined)

    const id = await seedMainChat("  hello there  ", { createSession, setActiveSession, setDraft })

    expect(id).toBe("s1")
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith("s1", "hello there")
    expect(setActiveSession).toHaveBeenCalledWith("s1")
  })

  it("still activates the session when the seed text is empty (no draft write)", async () => {
    const setActiveSession = jest.fn()
    const setDraft = jest.fn().mockResolvedValue(undefined)
    const id = await seedMainChat("   ", {
      createSession: () => ({ id: "s2" }),
      setActiveSession,
      setDraft,
    })
    expect(id).toBe("s2")
    expect(setDraft).not.toHaveBeenCalled()
    expect(setActiveSession).toHaveBeenCalledWith("s2")
  })

  it("still activates even if the draft write fails", async () => {
    const setActiveSession = jest.fn()
    const id = await seedMainChat("hi", {
      createSession: () => ({ id: "s3" }),
      setActiveSession,
      setDraft: jest.fn().mockRejectedValue(new Error("db down")),
    })
    expect(id).toBe("s3")
    expect(setActiveSession).toHaveBeenCalledWith("s3")
  })
})
