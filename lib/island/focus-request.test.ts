import {
  __resetIslandFocusForTesting,
  ISLAND_FOCUS_PENDING_MS,
  requestIslandFocus,
  takePendingIslandFocus,
  type IslandFocusDeps,
} from "./focus-request"

const T0 = 1_000_000

function deps(patch: Partial<IslandFocusDeps> = {}): jest.Mocked<IslandFocusDeps> {
  return {
    isOpen: jest.fn().mockResolvedValue(true),
    open: jest.fn().mockResolvedValue(true),
    send: jest.fn().mockResolvedValue(true),
    now: jest.fn().mockReturnValue(T0),
    ...patch,
  } as jest.Mocked<IslandFocusDeps>
}

beforeEach(() => {
  __resetIslandFocusForTesting()
})

describe("requestIslandFocus", () => {
  describe("island already open", () => {
    it("sends the focus directly and returns true without opening or parking", async () => {
      const d = deps()
      await expect(requestIslandFocus("row-1", d)).resolves.toBe(true)
      expect(d.send).toHaveBeenCalledWith("row-1")
      expect(d.open).not.toHaveBeenCalled()
      expect(takePendingIslandFocus(T0)).toBeNull()
    })

    it("sends nothing for a null row but still reports true", async () => {
      const d = deps()
      await expect(requestIslandFocus(null, d)).resolves.toBe(true)
      expect(d.send).not.toHaveBeenCalled()
    })

    it("clears a previously parked focus", async () => {
      const closed = deps({ isOpen: jest.fn().mockResolvedValue(false) })
      await requestIslandFocus("old", closed)
      await requestIslandFocus("new", deps())
      expect(takePendingIslandFocus(T0)).toBeNull()
    })

    it("still returns true when the send reports failure", async () => {
      const d = deps({ send: jest.fn().mockResolvedValue(false) })
      await expect(requestIslandFocus("row-1", d)).resolves.toBe(true)
    })
  })

  describe("island closed", () => {
    const closed = (patch: Partial<IslandFocusDeps> = {}) =>
      deps({ isOpen: jest.fn().mockResolvedValue(false), ...patch })

    it("parks the row, opens the island and returns true", async () => {
      const d = closed()
      await expect(requestIslandFocus("row-1", d)).resolves.toBe(true)
      expect(d.open).toHaveBeenCalledTimes(1)
      expect(d.send).not.toHaveBeenCalled()
      expect(takePendingIslandFocus(T0 + 1)).toBe("row-1")
    })

    it("parks with an expiry measured from the injected clock", async () => {
      await requestIslandFocus("row-1", closed())
      expect(takePendingIslandFocus(T0 + ISLAND_FOCUS_PENDING_MS - 1)).toBe("row-1")
    })

    it("clears the park and returns false when the island fails to open", async () => {
      const d = closed({ open: jest.fn().mockResolvedValue(false) })
      await expect(requestIslandFocus("row-1", d)).resolves.toBe(false)
      expect(takePendingIslandFocus(T0)).toBeNull()
    })

    it("parks nothing for a null row, but still opens the island", async () => {
      const d = closed()
      await expect(requestIslandFocus(null, d)).resolves.toBe(true)
      expect(d.open).toHaveBeenCalledTimes(1)
      expect(takePendingIslandFocus(T0)).toBeNull()
    })

    it("replaces an earlier parked row", async () => {
      await requestIslandFocus("first", closed())
      await requestIslandFocus("second", closed())
      expect(takePendingIslandFocus(T0)).toBe("second")
    })

    it("a null request drops an earlier parked row", async () => {
      await requestIslandFocus("first", closed())
      await requestIslandFocus(null, closed())
      expect(takePendingIslandFocus(T0)).toBeNull()
    })

    it("parks before opening, so the island's mount-time request can find it", async () => {
      let seenDuringOpen: string | null = null
      const d = closed({
        open: jest.fn(async () => {
          seenDuringOpen = takePendingIslandFocus(T0)
          return true
        }),
      })
      await requestIslandFocus("row-1", d)
      expect(seenDuringOpen).toBe("row-1")
    })
  })
})

describe("takePendingIslandFocus", () => {
  const park = () =>
    requestIslandFocus("row-1", deps({ isOpen: jest.fn().mockResolvedValue(false) }))

  it("returns null when nothing is parked", () => {
    expect(takePendingIslandFocus(T0)).toBeNull()
  })

  it("returns the parked id once, then null", async () => {
    await park()
    expect(takePendingIslandFocus(T0 + 10)).toBe("row-1")
    expect(takePendingIslandFocus(T0 + 10)).toBeNull()
  })

  it("expires at ISLAND_FOCUS_PENDING_MS", async () => {
    await park()
    expect(takePendingIslandFocus(T0 + ISLAND_FOCUS_PENDING_MS)).toBeNull()
  })

  it("clears an expired park so a later take cannot resurrect it", async () => {
    await park()
    expect(takePendingIslandFocus(T0 + ISLAND_FOCUS_PENDING_MS + 1)).toBeNull()
    expect(takePendingIslandFocus(T0)).toBeNull()
  })
})
