import type { Transport } from "@/lib/tauri/transport-types"

import { RemoteDesktopError } from "./host-client"
import {
  attachRfbChannel,
  BufferedRfbChannel,
  openRemoteDesktopStream,
  RFB_CHUNK_BYTES,
  type RemoteDesktopRawChannel,
} from "./stream"
import type { RemoteDesktopSessionOpened } from "./types"

/** The parts of `RTCDataChannel` the stream touches. */
class FakeChannel {
  binaryType = "blob"
  protocol = ""
  readyState: RTCDataChannelState = "connecting"
  label = "cognia.rfb"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  sent: unknown[] = []
  closed = false
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = "closed"
  }
  open() {
    this.readyState = "open"
    this.onopen?.(new Event("open"))
  }
  deliver(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }))
  }
}

const asChannel = (fake: FakeChannel) => fake as unknown as RTCDataChannel

const companionSession: RemoteDesktopSessionOpened = {
  sessionId: "abc123",
  transport: "companion",
  mode: "control",
  expiresAt: 1,
}

describe("attachRfbChannel", () => {
  it("attaches once open and keeps the bytes that follow the answer", async () => {
    jest.useFakeTimers()
    const fake = new FakeChannel()
    const attached = attachRfbChannel(asChannel(fake), "abc123")
    expect(fake.sent).toEqual([])
    fake.open()
    expect(fake.sent).toEqual([JSON.stringify({ type: "attach", sessionId: "abc123" })])
    fake.deliver(JSON.stringify({ type: "attached" }))
    // The banner arrives before anyone listens.
    fake.deliver(new Uint8Array([82, 70, 66]).buffer)
    const channel = await attached
    expect(fake.binaryType).toBe("arraybuffer")
    const seen: unknown[] = []
    channel.onmessage = (event) => seen.push(event.data)
    expect(seen).toEqual([])
    fake.deliver(new Uint8Array([1]).buffer)
    jest.runOnlyPendingTimers()
    expect(seen.map((data) => new Uint8Array(data as ArrayBuffer)[0])).toEqual([82, 1])
    // Live messages go straight through once drained.
    fake.deliver(new Uint8Array([2]).buffer)
    expect(seen).toHaveLength(3)
    jest.useRealTimers()
  })

  it("rejects with the Host's code and closes the channel", async () => {
    const fake = new FakeChannel()
    fake.readyState = "open"
    const attached = attachRfbChannel(asChannel(fake), "abc123")
    fake.deliver(JSON.stringify({ type: "error", code: "remote_desktop_session_not_found" }))
    await expect(attached).rejects.toMatchObject({ code: "remote_desktop_session_not_found" })
    expect(fake.closed).toBe(true)
  })

  it("refuses bytes before the answer, a closed channel and silence", async () => {
    const binary = new FakeChannel()
    binary.readyState = "open"
    const early = attachRfbChannel(asChannel(binary), "s")
    binary.deliver(new ArrayBuffer(1))
    await expect(early).rejects.toMatchObject({ code: "remote_desktop_protocol_invalid" })

    const garbled = new FakeChannel()
    garbled.readyState = "open"
    const bad = attachRfbChannel(asChannel(garbled), "s")
    garbled.deliver("not json")
    await expect(bad).rejects.toMatchObject({ code: "remote_desktop_protocol_invalid" })

    const dropped = new FakeChannel()
    const lost = attachRfbChannel(asChannel(dropped), "s")
    dropped.onclose?.(new Event("close"))
    await expect(lost).rejects.toMatchObject({ code: "remote_desktop_connection_lost" })

    jest.useFakeTimers()
    const silent = new FakeChannel()
    silent.readyState = "open"
    const late = attachRfbChannel(asChannel(silent), "s", 50)
    jest.advanceTimersByTime(60)
    await expect(late).rejects.toMatchObject({ code: "remote_desktop_ticket_expired" })
    jest.useRealTimers()
  })
})

describe("BufferedRfbChannel", () => {
  it("exposes the raw-channel surface noVNC checks for", () => {
    const fake = new FakeChannel()
    fake.readyState = "open"
    const channel = new BufferedRfbChannel(asChannel(fake))
    const names = [
      ...Object.keys(channel),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel)),
    ]
    for (const prop of [
      "send",
      "close",
      "binaryType",
      "onerror",
      "onmessage",
      "onopen",
      "protocol",
      "readyState",
    ]) {
      expect(names).toContain(prop)
    }
    expect(channel.readyState).toBe("open")
    channel.send(new Uint8Array([9]))
    expect(fake.sent).toHaveLength(1)
    channel.send(new ArrayBuffer(RFB_CHUNK_BYTES + 3))
    expect(fake.sent.slice(1).map((piece) => (piece as Uint8Array).byteLength)).toEqual([
      RFB_CHUNK_BYTES,
      3,
    ])
    const closed = jest.fn()
    channel.onclose = closed
    fake.onclose?.(new Event("close"))
    expect(closed).toHaveBeenCalled()
    channel.close()
    expect(fake.closed).toBe(true)
  })
})

describe("openRemoteDesktopStream", () => {
  it("hands the desktop its loopback URL and refuses one for anyone else", async () => {
    const loopback: RemoteDesktopSessionOpened = {
      ...companionSession,
      transport: "loopback",
      url: "ws://127.0.0.1:1/rd/t",
    }
    const stream = await openRemoteDesktopStream({ kind: "local" }, loopback)
    expect(stream.connection).toBe("ws://127.0.0.1:1/rd/t")
    await expect(
      openRemoteDesktopStream({ kind: "remote", hostRef: "h" }, loopback)
    ).rejects.toBeInstanceOf(RemoteDesktopError)
    await expect(
      openRemoteDesktopStream({ kind: "local" }, companionSession)
    ).rejects.toMatchObject({ code: "remote_desktop_protocol_invalid" })
  })

  function lease(transport: Partial<Record<string, unknown>>) {
    const release = jest.fn()
    return {
      release,
      acquire: jest.fn(async () => ({ transport: transport as unknown as Transport, release })),
    }
  }

  it("uses a ticketed socket on a connected HTTPS+WS tier", async () => {
    const socketUrl = jest.fn(async () => "wss://host/ws/remote-desktop/abc123?ticket=t")
    const held = lease({ getActiveTier: () => "ws-lan", remoteDesktopSocketUrl: socketUrl })
    const stream = await openRemoteDesktopStream(
      { kind: "remote", hostRef: "companion:h" },
      companionSession,
      { acquire: held.acquire }
    )
    expect(held.acquire).toHaveBeenCalledWith("companion:h")
    expect(socketUrl).toHaveBeenCalledWith("abc123")
    expect(stream.connection).toBe("wss://host/ws/remote-desktop/abc123?ticket=t")
    expect(held.release).not.toHaveBeenCalled()
    stream.close()
    expect(held.release).toHaveBeenCalledTimes(1)
  })

  it("attaches a cognia.rfb channel on a WebRTC tier", async () => {
    const fake = new FakeChannel()
    const held = lease({
      getActiveTier: () => "rtc-relay",
      openRfbDataChannel: () => asChannel(fake),
    })
    const opening = openRemoteDesktopStream(
      { kind: "remote", hostRef: "companion:h" },
      companionSession,
      { acquire: held.acquire }
    )
    await Promise.resolve()
    await Promise.resolve()
    fake.open()
    fake.deliver(JSON.stringify({ type: "attached" }))
    const stream = await opening
    expect(stream.connection).toBeInstanceOf(BufferedRfbChannel)
    stream.close()
    expect(fake.closed).toBe(true)
    expect(held.release).toHaveBeenCalledTimes(1)
  })

  it("says so when the connection cannot carry a stream, and gives the lease back", async () => {
    for (const transport of [
      { getActiveTier: () => "relay" },
      { getActiveTier: () => "offline" },
      { getActiveTier: () => "rtc-direct", openRfbDataChannel: () => null },
      {},
    ]) {
      const held = lease(transport)
      await expect(
        openRemoteDesktopStream({ kind: "remote", hostRef: "h" }, companionSession, {
          acquire: held.acquire,
        })
      ).rejects.toMatchObject({ code: "remote_desktop_transport_unavailable" })
      expect(held.release).toHaveBeenCalledTimes(1)
    }
  })

  it("passes a refused attach through and releases the lease", async () => {
    const fake = new FakeChannel()
    fake.readyState = "open"
    const held = lease({
      getActiveTier: () => "rtc-direct",
      openRfbDataChannel: () => asChannel(fake),
    })
    const opening = openRemoteDesktopStream({ kind: "remote", hostRef: "h" }, companionSession, {
      acquire: held.acquire,
    })
    await Promise.resolve()
    await Promise.resolve()
    fake.deliver(JSON.stringify({ type: "error", code: "remote_desktop_forbidden" }))
    await expect(opening).rejects.toMatchObject({ code: "remote_desktop_forbidden" })
    expect(held.release).toHaveBeenCalledTimes(1)
  })
})

// Type-level check: the buffered channel satisfies the viewer's raw surface.
const _surface: (channel: BufferedRfbChannel) => RemoteDesktopRawChannel = (channel) => channel
void _surface
