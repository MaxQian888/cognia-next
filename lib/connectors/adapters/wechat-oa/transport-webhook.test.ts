import { listen } from "@tauri-apps/api/event"
import { startWechatOaWebhook } from "./transport-webhook"

const mockListen = listen as jest.Mock

describe("startWechatOaWebhook", () => {
  beforeEach(() => mockListen.mockReset())

  it("yields decrypted xml payloads and stops on abort", async () => {
    let handler: ((e: { payload: { xml?: string } }) => void) | null = null
    mockListen.mockImplementation(async (_name: string, h: unknown) => {
      handler = h as (e: { payload: { xml?: string } }) => void
      return jest.fn()
    })

    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "wxoa-1", signal: ctrl.signal })

    const out: string[] = []
    const collector = (async () => {
      for await (const xml of gen) {
        out.push(xml)
        if (out.length >= 1) ctrl.abort()
      }
    })()

    // Wait for the listener to register.
    await new Promise((r) => setTimeout(r, 5))
    handler!({ payload: { xml: "<xml>hi</xml>" } })
    await collector

    expect(out).toEqual(["<xml>hi</xml>"])
  })

  it("ignores payloads without an xml string", async () => {
    let handler: ((e: { payload: { xml?: string } }) => void) | null = null
    mockListen.mockImplementation(async (_name: string, h: unknown) => {
      handler = h as (e: { payload: { xml?: string } }) => void
      return jest.fn()
    })
    const ctrl = new AbortController()
    const gen = startWechatOaWebhook({ adapterId: "wxoa-1", signal: ctrl.signal })
    const out: string[] = []
    const collector = (async () => {
      for await (const xml of gen) out.push(xml)
    })()
    await new Promise((r) => setTimeout(r, 5))
    handler!({ payload: {} })
    ctrl.abort()
    await collector
    expect(out).toHaveLength(0)
  })
})
