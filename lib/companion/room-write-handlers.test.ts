const getHostRoomRunnerMock = jest.fn()
jest.mock("@/lib/chat/room/runner-host", () => ({
  getHostRoomRunner: () => getHostRoomRunnerMock(),
}))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "acct-local",
}))
const readHostPersonMock = jest.fn()
jest.mock("@/lib/identity/host-person", () => ({
  readHostPerson: (...args: unknown[]) => readHostPersonMock(...args),
}))
const getPairedDeviceMock = jest.fn()
jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: (...args: unknown[]) => getPairedDeviceMock(...args),
}))

import { resolveRoomAuthor, roomSend, roomStop } from "./room-write-handlers"
import type { RoomRunner } from "@/lib/chat/room/runner"

function fakeRunner() {
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const runner = {
    send: jest.fn(() => pending),
    regenerate: jest.fn(() => pending),
    editAndResend: jest.fn(() => pending),
    stop: jest.fn(async () => undefined),
  }
  return { runner: runner as unknown as RoomRunner, calls: runner, release }
}

const deps = (runner: RoomRunner) => ({
  runner: () => runner,
  hostUserId: async () => "usr_host",
  deviceLabel: async (id: string) => (id === "dev-1" ? "Pixel 9" : undefined),
})

beforeEach(() => {
  getHostRoomRunnerMock.mockReset()
  readHostPersonMock.mockReset()
  getPairedDeviceMock.mockReset()
})

describe("resolveRoomAuthor", () => {
  it("names the host's bound person and records the device as provenance", async () => {
    await expect(resolveRoomAuthor("dev-1", deps(fakeRunner().runner))).resolves.toEqual({
      kind: "human",
      id: "usr_host",
      displayName: "Pixel 9",
      source: "device:dev-1",
    })
  })

  it("falls back to the local account when the host is bound to nobody", async () => {
    const author = await resolveRoomAuthor("dev-9", {
      hostUserId: async () => null,
      deviceLabel: async () => undefined,
    })
    expect(author).toEqual({ kind: "human", id: "acct-local", source: "device:dev-9" })
  })

  it("reads the person and the device label through the production lookups by default", async () => {
    readHostPersonMock.mockResolvedValue({ userId: "usr_a", canonicalUserId: "usr_canon" })
    getPairedDeviceMock.mockResolvedValue({ label: "Desk phone" })
    await expect(resolveRoomAuthor("dev-2")).resolves.toEqual({
      kind: "human",
      id: "usr_canon",
      displayName: "Desk phone",
      source: "device:dev-2",
    })
    expect(readHostPersonMock).toHaveBeenCalledWith("acct-local")
    expect(getPairedDeviceMock).toHaveBeenCalledWith("dev-2")
  })

  it("survives a failing person or device lookup", async () => {
    readHostPersonMock.mockRejectedValue(new Error("no identity table"))
    getPairedDeviceMock.mockRejectedValue(new Error("no devices table"))
    await expect(resolveRoomAuthor("dev-3")).resolves.toEqual({
      kind: "human",
      id: "acct-local",
      source: "device:dev-3",
    })
  })
})

describe("roomSend", () => {
  it("refuses a payload without a session or without the injected caller", async () => {
    const { runner } = fakeRunner()
    await expect(roomSend({ content: "x", callerDeviceId: "d" }, deps(runner))).rejects.toThrow(
      "room_send.sessionId is required"
    )
    await expect(roomSend({ sessionId: "room-1", content: "x" }, deps(runner))).rejects.toThrow(
      "room_send.callerDeviceId is required"
    )
  })

  it("accepts the turn before it finishes and stamps the caller as author", async () => {
    const { runner, calls, release } = fakeRunner()
    const result = await roomSend(
      {
        sessionId: "room-1",
        callerDeviceId: "dev-1",
        content: "hello team",
        attachmentManifest: [{ id: "att-1" }],
        webSearchContext: { query: "q" },
      },
      deps(runner)
    )
    expect(result).toEqual({ accepted: true })
    expect(calls.send).toHaveBeenCalledWith("hello team", {
      sessionId: "room-1",
      attachmentManifest: [{ id: "att-1" }],
      webSearchContext: { query: "q" },
      author: { kind: "human", id: "usr_host", displayName: "Pixel 9", source: "device:dev-1" },
    })
    release()
  })

  it("accepts content blocks and rejects anything else", async () => {
    const { runner, calls, release } = fakeRunner()
    const blocks = [{ type: "text", text: "see this" }]
    await roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: blocks }, deps(runner))
    expect(calls.send).toHaveBeenCalledWith(
      blocks,
      expect.objectContaining({ sessionId: "room-1" })
    )
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: 42 }, deps(runner))
    ).rejects.toThrow("room_send.content must be a string or blocks")
    release()
  })

  it("routes regenerate and edit to their own runner actions", async () => {
    const { runner, calls, release } = fakeRunner()
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", regenerate: true }, deps(runner))
    ).resolves.toEqual({ accepted: true })
    expect(calls.regenerate).toHaveBeenCalledWith("room-1")
    expect(calls.send).not.toHaveBeenCalled()

    await roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "fixed", editMessageId: "u-1" },
      deps(runner)
    )
    expect(calls.editAndResend).toHaveBeenCalledWith("room-1", "u-1", "fixed")
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "x", editMessageId: 7 },
        deps(runner)
      )
    ).rejects.toThrow("room_send.editMessageId must be a string when present")
    release()
  })

  it("uses the process-wide host runner when no runner is injected", async () => {
    const { runner, calls, release } = fakeRunner()
    getHostRoomRunnerMock.mockReturnValue(runner)
    readHostPersonMock.mockResolvedValue(null)
    getPairedDeviceMock.mockResolvedValue(undefined)
    await roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" })
    expect(getHostRoomRunnerMock).toHaveBeenCalled()
    expect(calls.send).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        author: { kind: "human", id: "acct-local", source: "device:dev-1" },
      })
    )
    release()
  })

  it("does not fail the RPC when the detached turn later rejects", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    const runner = {
      send: jest.fn(async () => {
        throw new Error("member exploded")
      }),
    } as unknown as RoomRunner
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" }, deps(runner))
    ).resolves.toEqual({ accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(consoleError).toHaveBeenCalledWith("room send failed", expect.any(Error))
    consoleError.mockRestore()
  })
})

describe("roomStop", () => {
  it("stops the room and waits for the interrupt acks", async () => {
    const { runner, calls } = fakeRunner()
    await expect(
      roomStop({ sessionId: "room-1", callerDeviceId: "dev-1" }, deps(runner))
    ).resolves.toBeNull()
    expect(calls.stop).toHaveBeenCalledWith("room-1")
  })

  it("refuses without a session or a verified caller", async () => {
    const { runner } = fakeRunner()
    await expect(roomStop({ callerDeviceId: "dev-1" }, deps(runner))).rejects.toThrow(
      "room_stop.sessionId is required"
    )
    await expect(roomStop({ sessionId: "room-1" }, deps(runner))).rejects.toThrow(
      "room_stop.callerDeviceId is required"
    )
  })
})
