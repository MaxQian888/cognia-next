/**
 * The plugin contract's share of `lib/remote-desktop/stream.ts`, which re-exports these.
 */
/** The raw-channel surface noVNC's `Websock.attach` checks for. */
export interface RemoteDesktopRawChannel {
  binaryType: string
  readonly protocol: string
  readonly readyState: string
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: ArrayBuffer | ArrayBufferView): void
  close(): void
}

/** A viewer connects to a URL (it opens the WebSocket) or an open channel. */
export type RemoteDesktopConnection = string | RemoteDesktopRawChannel
