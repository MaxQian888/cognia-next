/** @jest-environment jsdom */
import type { Transport } from "@/lib/tauri/transport-types"
import { setTransport } from "@/lib/tauri/transport-instance"
import { liveFilesRemoteClient, liveFilesTransport } from "./live-transport"

function fakeTransport(withBinary = true): Transport & { call: jest.Mock; readBinary?: jest.Mock } {
  return {
    call: jest.fn().mockResolvedValue({ ok: true, folders: [] }),
    ...(withBinary
      ? { readBinary: jest.fn().mockResolvedValue({ bytes: new Uint8Array(), mediaType: "x" }) }
      : {}),
  } as unknown as Transport & { call: jest.Mock; readBinary?: jest.Mock }
}

describe("live files transport", () => {
  it("calls whichever transport is installed when the call is made", async () => {
    const first = fakeTransport()
    setTransport(first)
    const client = liveFilesRemoteClient()
    await client.folders()
    expect(first.call.mock.calls[0]![0]).toBe("files_library_folder_list")

    const second = fakeTransport()
    setTransport(second)
    await client.folders()
    expect(second.call).toHaveBeenCalledTimes(1)
    expect(first.call).toHaveBeenCalledTimes(1)
  })

  it("reads binaries through the installed transport, or refuses by code without one", async () => {
    const binary = fakeTransport()
    setTransport(binary)
    const resource = {
      kind: "session-media",
      sessionId: "s",
      hash: "a".repeat(64),
      variant: "original",
    } as const
    await liveFilesTransport.readBinary!(resource)
    expect(binary.readBinary).toHaveBeenCalledWith(resource)

    setTransport(fakeTransport(false))
    await expect(liveFilesTransport.readBinary!(resource)).rejects.toMatchObject({
      code: "files_remote_media_unavailable",
    })
  })
})
