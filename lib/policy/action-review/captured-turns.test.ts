import {
  __resetCapturedTurnsForTesting,
  beginCapturedTurn,
  capturedTurnOf,
  type CapturedTurn,
} from "./captured-turns"

const turn = (turnId: string, unattended = true): CapturedTurn => ({
  turnId,
  outboundPolicy: { unattended },
})

beforeEach(() => __resetCapturedTurnsForTesting())

describe("captured turns", () => {
  it("knows a session's turn while it runs, and nothing after", () => {
    expect(capturedTurnOf("s1")).toBeUndefined()
    const end = beginCapturedTurn("s1", turn("t1"))
    expect(capturedTurnOf("s1")?.turnId).toBe("t1")
    expect(capturedTurnOf("s2")).toBeUndefined()
    end()
    expect(capturedTurnOf("s1")).toBeUndefined()
    end()
    expect(capturedTurnOf("s1")).toBeUndefined()
  })

  it("lets the newest turn of a session answer, and the older one again once it ends", () => {
    const endFirst = beginCapturedTurn("s1", turn("t1"))
    const endSecond = beginCapturedTurn("s1", turn("t2", false))
    expect(capturedTurnOf("s1")).toMatchObject({
      turnId: "t2",
      outboundPolicy: { unattended: false },
    })
    endSecond()
    expect(capturedTurnOf("s1")?.turnId).toBe("t1")
    endFirst()
    expect(capturedTurnOf("s1")).toBeUndefined()
  })

  it("ending an older turn leaves the newer one", () => {
    const endFirst = beginCapturedTurn("s1", turn("t1"))
    beginCapturedTurn("s1", turn("t2"))
    endFirst()
    expect(capturedTurnOf("s1")?.turnId).toBe("t2")
  })
})
