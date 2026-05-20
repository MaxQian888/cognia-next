/**
 * @jest-environment jsdom
 */
import {
  cancel,
  checkPermission,
  ensureChannel,
  ensurePermission,
  listPending,
  requestPermission,
  schedule,
} from "./local-notifications"

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    schedule: jest.fn().mockResolvedValue({ notifications: [{ id: 1 }, { id: 2 }] }),
    cancel: jest.fn().mockResolvedValue(undefined),
    getPending: jest.fn().mockResolvedValue({ notifications: [] }),
    requestPermissions: jest.fn().mockResolvedValue({ display: "granted" }),
    checkPermissions: jest.fn().mockResolvedValue({ display: "granted" }),
    createChannel: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as {
    schedule: jest.Mock
    cancel: jest.Mock
    getPending: jest.Mock
    requestPermissions: jest.Mock
    checkPermissions: jest.Mock
    createChannel: jest.Mock
  }
}

describe("ensurePermission", () => {
  it("returns granted when checkPermissions returns granted", async () => {
    const p = makePlugin()
    const out = await ensurePermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "granted" })
    expect(p.requestPermissions).not.toHaveBeenCalled()
  })

  it("requests permission when not granted", async () => {
    const p = makePlugin({
      checkPermissions: jest.fn().mockResolvedValue({ display: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ display: "granted" }),
    })
    const out = await ensurePermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "granted" })
    expect(p.requestPermissions).toHaveBeenCalled()
  })

  it("normalizes denied to denied", async () => {
    const p = makePlugin({
      checkPermissions: jest.fn().mockResolvedValue({ display: "denied" }),
      requestPermissions: jest.fn().mockResolvedValue({ display: "denied" }),
    })
    const out = await ensurePermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "denied" })
  })
})

describe("checkPermission", () => {
  it("returns granted without calling requestPermissions", async () => {
    const p = makePlugin()
    const out = await checkPermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "granted" })
    expect(p.requestPermissions).not.toHaveBeenCalled()
  })

  it("returns prompt when display is prompt-with-rationale", async () => {
    const p = makePlugin({
      checkPermissions: jest.fn().mockResolvedValue({ display: "prompt-with-rationale" }),
    })
    const out = await checkPermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "prompt" })
  })

  it("returns denied when display is denied", async () => {
    const p = makePlugin({
      checkPermissions: jest.fn().mockResolvedValue({ display: "denied" }),
    })
    const out = await checkPermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "denied" })
  })
})

describe("requestPermission", () => {
  it("calls requestPermissions and returns granted", async () => {
    const p = makePlugin()
    const out = await requestPermission(async () => p)
    expect(p.requestPermissions).toHaveBeenCalled()
    expect(out).toEqual({ kind: "ok", value: "granted" })
  })

  it("returns denied when user rejects", async () => {
    const p = makePlugin({
      requestPermissions: jest.fn().mockResolvedValue({ display: "denied" }),
    })
    const out = await requestPermission(async () => p)
    expect(out).toEqual({ kind: "ok", value: "denied" })
  })
})

describe("schedule / cancel / listPending", () => {
  it("schedule returns the ids", async () => {
    const p = makePlugin()
    const out = await schedule(
      [
        { id: 1, title: "x", body: "y" },
        { id: 2, title: "a", body: "b" },
      ],
      async () => p
    )
    expect(out).toEqual({ kind: "ok", value: [1, 2] })
  })

  it("cancel forwards id list", async () => {
    const p = makePlugin()
    await cancel([3, 4], async () => p)
    expect(p.cancel).toHaveBeenCalledWith({ notifications: [{ id: 3 }, { id: 4 }] })
  })

  it("listPending returns pending notifications", async () => {
    const p = makePlugin({
      getPending: jest.fn().mockResolvedValue({
        notifications: [{ id: 5, title: "x", body: "y" }],
      }),
    })
    const out = await listPending(async () => p)
    expect(out).toEqual({
      kind: "ok",
      value: [{ id: 5, title: "x", body: "y" }],
    })
  })
})

describe("ensureChannel", () => {
  it("creates channel on Android (createChannel present)", async () => {
    const p = makePlugin()
    await ensureChannel(
      { id: "default", name: "Default", description: "x", importance: 4 },
      async () => p
    )
    expect(p.createChannel).toHaveBeenCalledWith({
      id: "default",
      name: "Default",
      description: "x",
      importance: 4,
      sound: undefined,
    })
  })

  it("no-ops on iOS (createChannel absent)", async () => {
    const p = { ...makePlugin(), createChannel: undefined }
    const out = await ensureChannel({ id: "x", name: "X" }, async () => p)
    expect(out).toEqual({ kind: "ok" })
  })
})
