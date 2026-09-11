const callMock = jest.fn<Promise<unknown>, [string, unknown]>()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: [string, unknown]) => callMock(...args) },
}))

import {
  ROOM_SEND_COMMAND,
  ROOM_STOP_COMMAND,
  sendRoomTurn,
  stopRoomTurn,
} from "./room-send-client"

beforeEach(() => {
  callMock.mockReset()
})

describe("sendRoomTurn", () => {
  it("forwards optional template provenance to the host", async () => {
    const templateRun = {
      templateId: "review",
      version: "1",
      text: "Review {{target}}",
      params: { target: { kind: "text" as const, value: "workflow" } },
    }
    callMock.mockResolvedValue({ accepted: true })
    await sendRoomTurn({ sessionId: "room-1", content: "review", templateRun })
    expect(callMock).toHaveBeenCalledWith(ROOM_SEND_COMMAND, {
      sessionId: "room-1",
      content: "review",
      templateRun,
    })
  })

  it("sends the turn over the routing transport under the bridged command name", async () => {
    callMock.mockResolvedValue({ accepted: true })
    const result = await sendRoomTurn({
      sessionId: "room-1",
      content: "hello",
      webSearchContext: { query: "q" } as never,
    })
    expect(result).toEqual({ accepted: true })
    expect(callMock).toHaveBeenCalledWith(ROOM_SEND_COMMAND, {
      sessionId: "room-1",
      content: "hello",
      webSearchContext: { query: "q" },
    })
    expect(ROOM_SEND_COMMAND).toBe("room_send")
  })

  it("copies a readonly attachment manifest into a plain array for the wire", async () => {
    callMock.mockResolvedValue({ accepted: true })
    const manifest = Object.freeze([{ id: "att-1", kind: "image" }]) as never
    await sendRoomTurn({ sessionId: "room-1", content: "see", attachmentManifest: manifest })
    const payload = callMock.mock.calls[0][1] as { attachmentManifest: unknown[] }
    expect(payload.attachmentManifest).toEqual([{ id: "att-1", kind: "image" }])
    expect(Object.isFrozen(payload.attachmentManifest)).toBe(false)
  })

  it("forwards regenerate and edit requests without inventing content", async () => {
    callMock.mockResolvedValue({ accepted: true })
    await sendRoomTurn({ sessionId: "room-1", regenerate: true })
    expect(callMock).toHaveBeenLastCalledWith(ROOM_SEND_COMMAND, {
      sessionId: "room-1",
      regenerate: true,
    })
    await sendRoomTurn({ sessionId: "room-1", content: "fixed", editMessageId: "u-1" })
    expect(callMock).toHaveBeenLastCalledWith(ROOM_SEND_COMMAND, {
      sessionId: "room-1",
      content: "fixed",
      editMessageId: "u-1",
    })
  })

  it("reads a null answer as not accepted rather than as success", async () => {
    callMock.mockResolvedValue(null)
    await expect(sendRoomTurn({ sessionId: "room-1", content: "x" })).resolves.toEqual({
      accepted: false,
    })
  })

  it("propagates a transport failure so the caller can roll back its optimistic row", async () => {
    callMock.mockRejectedValue(new Error("offline"))
    await expect(sendRoomTurn({ sessionId: "room-1", content: "x" })).rejects.toThrow("offline")
  })
})

describe("stopRoomTurn", () => {
  it("asks the host to stop the room by session id", async () => {
    callMock.mockResolvedValue(null)
    await stopRoomTurn("room-1")
    expect(callMock).toHaveBeenCalledWith(ROOM_STOP_COMMAND, { sessionId: "room-1" })
    expect(ROOM_STOP_COMMAND).toBe("room_stop")
  })
})
