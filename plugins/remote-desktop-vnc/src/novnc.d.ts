// noVNC 1.6.0 ships CommonJS without types. Only the surface the viewer uses
// is declared; see node_modules/@novnc/novnc/docs/API.md.
declare module "@novnc/novnc/lib/rfb" {
  export interface NoVncRfbOptions {
    shared?: boolean
    wsProtocols?: string[]
  }

  /** What `Websock.attach` accepts: a WebSocket or an `RTCDataChannel`-like channel. */
  export interface NoVncRawChannel {
    binaryType: string
    readonly protocol: string
    readonly readyState: string | number
    onopen: ((event: Event) => void) | null
    onmessage: ((event: MessageEvent) => void) | null
    onclose: ((event: Event) => void) | null
    onerror: ((event: Event) => void) | null
    send(data: ArrayBuffer | ArrayBufferView): void
    close(): void
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | NoVncRawChannel,
      options?: NoVncRfbOptions
    )
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    background: string
    disconnect(): void
    focus(): void
    /** `down` undefined presses and releases; `code` may be null. */
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
  }
}
