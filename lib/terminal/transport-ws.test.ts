/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  isCapacitor: () => true,
}))

import {
  RemoteTerminalSession,
  configureCompanionEndpointResolver,
  pickRemoteSpawn,
} from "./transport-ws"

interface MockWS {
  url: string
  readyState: number
  binaryType: string
  sent: Array<string | Uint8Array>
  listeners: Record<string, Array<(e: MessageEvent | CloseEvent | Event) => void>>
  send: jest.Mock
  close: jest.Mock
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fireMessage: (data: string | ArrayBuffer) => void
  fireClose: (code?: number) => void
  fireError: () => void
}

let lastWs: MockWS | null = null

beforeAll(() => {
  ;(global as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    static CLOSED = 3
    url: string
    readyState: number = 1
    binaryType = "blob"
    private listeners: Record<string, Array<(e: MessageEvent | CloseEvent | Event) => void>> = {}
    sent: Array<string | Uint8Array> = []
    send = jest.fn((data: string | Uint8Array) => {
      this.sent.push(data)
    })
    close = jest.fn(() => {
      this.readyState = 3
    })
    addEventListener = jest.fn(
      (event: string, cb: (e: MessageEvent | CloseEvent | Event) => void) => {
        if (!this.listeners[event]) this.listeners[event] = []
        this.listeners[event].push(cb)
      }
    )
    removeEventListener = jest.fn(
      (event: string, cb: (e: MessageEvent | CloseEvent | Event) => void) => {
        const list = this.listeners[event]
        if (!list) return
        const i = list.indexOf(cb)
        if (i >= 0) list.splice(i, 1)
      }
    )
    fireMessage(data: string | ArrayBuffer) {
      const ev = new MessageEvent("message", { data })
      for (const l of this.listeners["message"] ?? []) l(ev)
    }
    fireClose(code = 1000) {
      const ev = { code } as CloseEvent
      for (const l of this.listeners["close"] ?? []) l(ev)
    }
    fireError() {
      const ev = new Event("error")
      for (const l of this.listeners["error"] ?? []) l(ev)
    }
    constructor(url: string) {
      this.url = url
      lastWs = this as unknown as MockWS
    }
  }
})

beforeEach(() => {
  lastWs = null
  configureCompanionEndpointResolver(async () => ({
    baseUrl: "wss://desktop.local:7654",
    token: "test-jwt",
  }))
})

afterEach(() => {
  configureCompanionEndpointResolver(async () => null)
})

describe("RemoteTerminalSession.spawn", () => {
  it("rejects when no companion endpoint is configured", async () => {
    configureCompanionEndpointResolver(async () => null)
    await expect(
      RemoteTerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
    ).rejects.toThrow(/not configured/)
  })

  it("opens a WS with the spawn querystring set", async () => {
    const spawnPromise = RemoteTerminalSession.spawn({
      shell: "/bin/bash",
      rows: 24,
      cols: 80,
      projectId: "proj-a",
    })
    await Promise.resolve()
    expect(lastWs).toBeTruthy()
    expect(lastWs!.url).toContain("/ws/v1/terminal")
    expect(lastWs!.url).toContain("token=test-jwt")
    expect(lastWs!.url).toContain("spawn=1")
    expect(lastWs!.url).toContain("shell=%2Fbin%2Fbash")
    expect(lastWs!.url).toContain("projectId=proj-a")
    lastWs!.fireMessage(JSON.stringify({ kind: "ready", sessionId: "s-1", shell: "/bin/bash" }))
    const session = await spawnPromise
    expect(session.id).toBe("s-1")
    expect(session.info.origin).toBe("remote")
  })

  it("rejects when the server responds with `error` instead of `ready`", async () => {
    const spawnPromise = RemoteTerminalSession.spawn({
      shell: "/bin/missing",
      rows: 24,
      cols: 80,
    })
    await Promise.resolve()
    lastWs!.fireMessage(JSON.stringify({ kind: "error", message: "no such shell" }))
    await expect(spawnPromise).rejects.toThrow(/no such shell/)
  })

  it("rejects when WS closes before ready", async () => {
    const spawnPromise = RemoteTerminalSession.spawn({
      shell: "/bin/sh",
      rows: 24,
      cols: 80,
    })
    await Promise.resolve()
    lastWs!.fireClose(1006)
    await expect(spawnPromise).rejects.toThrow(/closed before ready/)
  })
})

describe("RemoteTerminalSession runtime", () => {
  async function spawn() {
    const p = RemoteTerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
    await Promise.resolve()
    lastWs!.fireMessage(JSON.stringify({ kind: "ready", sessionId: "s-1", shell: "/bin/bash" }))
    return p
  }

  it("forwards binary frames to onData listeners as Uint8Array", async () => {
    const session = await spawn()
    const seen: Uint8Array[] = []
    session.onData((b) => seen.push(b))
    const buf = new Uint8Array([72, 105]).buffer
    lastWs!.fireMessage(buf)
    expect(seen).toHaveLength(1)
    expect(Array.from(seen[0]!)).toEqual([72, 105])
  })

  it("forwards integration text frames to onIntegration listeners", async () => {
    const session = await spawn()
    const events: unknown[] = []
    session.onIntegration((e) => events.push(e))
    lastWs!.fireMessage(JSON.stringify({ kind: "integration", event: { kind: "prompt_start" } }))
    expect(events).toEqual([{ kind: "prompt_start" }])
  })

  it("converts string writes to bytes via TextEncoder", async () => {
    const session = await spawn()
    await session.write("ls\n")
    const lastSent = lastWs!.sent[lastWs!.sent.length - 1]
    // Skip `toBeInstanceOf` — Uint8Array can land in a different realm
    // under jsdom; check the byte values directly which is what matters.
    expect(typeof lastSent).toBe("object")
    expect(Array.from(lastSent as Uint8Array)).toEqual([108, 115, 10])
  })

  it("emits a resize control frame", async () => {
    const session = await spawn()
    await session.resize(32, 120)
    expect(lastWs!.sent[lastWs!.sent.length - 1]).toBe(
      JSON.stringify({ kind: "resize", rows: 32, cols: 120 })
    )
  })

  it("emits a kill control frame + closes the socket", async () => {
    const session = await spawn()
    await session.kill()
    expect(lastWs!.sent.some((s) => s === JSON.stringify({ kind: "kill" }))).toBe(true)
    expect(lastWs!.close).toHaveBeenCalled()
  })

  it("fires onExit when the server sends an exit control frame", async () => {
    const session = await spawn()
    let code: number | null | undefined
    session.onExit((c) => {
      code = c
    })
    lastWs!.fireMessage(JSON.stringify({ kind: "exit", code: 1 }))
    expect(code).toBe(1)
    expect(session.isExited).toBe(true)
    expect(session.lastExitCode).toBe(1)
  })

  it("fires onExit on WS close (treat 1000 as exit 0, other codes as null)", async () => {
    const session = await spawn()
    let code: number | null | undefined
    session.onExit((c) => {
      code = c
    })
    lastWs!.fireClose(1006)
    expect(code).toBeNull()
  })

  it("invokes onExit immediately for late subscribers", async () => {
    const session = await spawn()
    lastWs!.fireMessage(JSON.stringify({ kind: "exit", code: 0 }))
    let code: number | null | undefined
    session.onExit((c) => {
      code = c
    })
    await Promise.resolve()
    expect(code).toBe(0)
  })
})

describe("pickRemoteSpawn", () => {
  it("returns the spawn fn on Capacitor", () => {
    const fn = pickRemoteSpawn()
    expect(fn).toBeTruthy()
  })
})
