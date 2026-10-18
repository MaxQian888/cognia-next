// noVNC 1.6.0 ships CommonJS without types. Only the surface the viewer uses
// is declared; see node_modules/@novnc/novnc/docs/API.md.
declare module "@novnc/novnc/lib/rfb" {
  export interface NoVncRfbOptions {
    shared?: boolean
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: NoVncRfbOptions)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    background: string
    disconnect(): void
    focus(): void
  }
}
