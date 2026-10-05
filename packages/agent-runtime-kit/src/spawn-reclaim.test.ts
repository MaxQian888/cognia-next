import { isExternalAgentAlreadyRunningError, spawnReclaimingOrphan } from "./spawn-reclaim"

describe("isExternalAgentAlreadyRunningError", () => {
  it("matches the process manager's collision message as a bare string", () => {
    // The Tauri command rejects with a string, not an Error.
    expect(
      isExternalAgentAlreadyRunningError("Agent oMjzXOmSIPqirvuBkwvcC is already running")
    ).toBe(true)
  })

  it("matches it when wrapped in an Error", () => {
    expect(
      isExternalAgentAlreadyRunningError(new Error("Agent codex-app is already running"))
    ).toBe(true)
  })

  it("does not match unrelated spawn failures", () => {
    expect(isExternalAgentAlreadyRunningError("Failed to spawn process: ENOENT")).toBe(false)
    expect(isExternalAgentAlreadyRunningError(new Error("Request timeout: initialize"))).toBe(false)
    expect(isExternalAgentAlreadyRunningError(undefined)).toBe(false)
    expect(isExternalAgentAlreadyRunningError(null)).toBe(false)
  })
})

describe("spawnReclaimingOrphan", () => {
  const collision = "Agent a1 is already running"

  it("spawns once and does not touch kill when the id is free", async () => {
    const kill = jest.fn(async () => {})
    const spawn = jest.fn(async () => "proc-1")
    const onReclaim = jest.fn()

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill, onReclaim })).resolves.toBe(
      "proc-1"
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
    expect(onReclaim).not.toHaveBeenCalled()
  })

  it("kills the orphan and respawns on a collision", async () => {
    const kill = jest.fn(async () => {})
    const spawn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce("proc-2")
    const onReclaim = jest.fn()

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill, onReclaim })).resolves.toBe(
      "proc-2"
    )

    expect(onReclaim).toHaveBeenCalledWith("a1")
    expect(kill).toHaveBeenCalledWith("a1")
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("propagates a failure that is not a collision without killing", async () => {
    const kill = jest.fn(async () => {})
    const spawn = jest.fn(async () => {
      throw "Failed to spawn process: ENOENT"
    })

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill })).rejects.toMatch(/ENOENT/)
    expect(kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("retries only once — a second collision surfaces", async () => {
    // Something genuinely holds the id; looping would spin forever.
    const kill = jest.fn(async () => {})
    const spawn = jest.fn(async () => {
      throw collision
    })

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill })).rejects.toMatch(
      /is already running/
    )
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it("surfaces a kill failure rather than masking it", async () => {
    const kill = jest.fn(async () => {
      throw new Error("kill denied")
    })
    const spawn = jest.fn(async () => {
      throw collision
    })

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill })).rejects.toThrow(/kill denied/)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("works without an onReclaim callback", async () => {
    const kill = jest.fn(async () => {})
    const spawn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce("proc-3")

    await expect(spawnReclaimingOrphan({ id: "a1", spawn, kill })).resolves.toBe("proc-3")
  })
})
