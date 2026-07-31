import { InMemoryTerminalHostConnection, WanTerminalHostConnection } from "./host-connection"
import { decodeTerminalFrame, makeTerminalFrame, TerminalFrameKind } from "./protocol"

class FakeTerminalDataChannel extends EventTarget {
  readonly label = "cognia.terminal"
  readonly ordered = true
  readyState: RTCDataChannelState = "connecting"
  binaryType: BinaryType = "blob"
  sent: Uint8Array[] = []

  send(value: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.sent.push(new Uint8Array(bytes))
  }

  open(): void {
    this.readyState = "open"
    this.dispatchEvent(new Event("open"))
  }

  receive(bytes: Uint8Array): void {
    this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer }))
  }

  close(): void {
    this.readyState = "closed"
    this.dispatchEvent(new Event("close"))
  }
}

describe("TerminalHostConnection", () => {
  it("preserves ordered binary frames through the in-memory adapter", async () => {
    const [client, host] = InMemoryTerminalHostConnection.pair()
    await Promise.all([client.open(), host.open()])
    const sequences: bigint[] = []
    host.onFrame((frame) => sequences.push(frame.sequence))

    await client.send(makeTerminalFrame(TerminalFrameKind.List, { sequence: BigInt(1) }))
    await client.send(makeTerminalFrame(TerminalFrameKind.List, { sequence: BigInt(2) }))
    await Promise.resolve()
    expect(sequences).toEqual([BigInt(1), BigInt(2)])
  })

  it("publishes connection state and refuses writes after close", async () => {
    const [client, host] = InMemoryTerminalHostConnection.pair()
    const states: string[] = []
    client.onState((state) => states.push(state))
    await Promise.all([client.open(), host.open()])
    await Promise.resolve()
    await client.close()
    await expect(client.send(makeTerminalFrame(TerminalFrameKind.List))).rejects.toThrow("not open")
    expect(states).toContain("connected")
    expect(states.at(-1)).toBe("closed")
  })

  it("carries canonical binary frames over the ordered WebRTC terminal channel", async () => {
    const channel = new FakeTerminalDataChannel()
    const connection = new WanTerminalHostConnection(channel as unknown as RTCDataChannel)
    const received: bigint[] = []
    connection.onFrame((frame) => received.push(frame.sequence))

    const opened = connection.open()
    channel.open()
    await opened
    await connection.send(makeTerminalFrame(TerminalFrameKind.List, { sequence: BigInt(7) }))
    expect(decodeTerminalFrame(channel.sent[0]).sequence).toBe(BigInt(7))

    channel.receive(channel.sent[0])
    expect(received).toEqual([BigInt(7)])
  })

  it("allocates request sequences across every session multiplexed on the WAN channel", () => {
    const channel = new FakeTerminalDataChannel()
    const connection = new WanTerminalHostConnection(channel as unknown as RTCDataChannel)
    expect(connection.nextSequence()).toBe(BigInt(1))
    expect(connection.nextSequence()).toBe(BigInt(2))
  })
})
