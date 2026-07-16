/** @jest-environment jsdom */
import { render, waitFor, cleanup } from "@testing-library/react"
import { ExposeTestGlobals } from "./expose-test-globals"

const originalEnv = process.env.NEXT_PUBLIC_E2E

const cleanWindowKeys: Array<keyof Window> = [
  "__cogniaResetDb",
  "__cogniaSeedWorkflow",
  "__cogniaSeedCharacter",
  "__cogniaSeedTeam",
  "__cogniaSeedSkill",
  "__cogniaSeedConnectorDraft",
  "__cogniaSeedRun",
  "__cogniaSetMockBaseUrls",
  "__cogniaMockBaseUrls",
  "__cogniaSaveCompanionConfig",
  "__cogniaClearCompanionConfig",
  "__cogniaSetSettings",
  "__cogniaTestGlobalsReady",
] as Array<keyof Window>

beforeEach(() => {
  for (const k of cleanWindowKeys) {
    delete (window as unknown as Record<string, unknown>)[k as string]
  }
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  process.env.NEXT_PUBLIC_E2E = originalEnv
})

describe("ExposeTestGlobals", () => {
  it("renders nothing", () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    const { container } = render(<ExposeTestGlobals />)
    expect(container.childNodes.length).toBe(0)
  })

  it("does not expose globals when NEXT_PUBLIC_E2E !== '1'", async () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    render(<ExposeTestGlobals />)
    await Promise.resolve()
    expect(window.__cogniaResetDb).toBeUndefined()
    expect(window.__cogniaSeedWorkflow).toBeUndefined()
    expect(window.__cogniaSeedCharacter).toBeUndefined()
    expect(window.__cogniaSeedTeam).toBeUndefined()
    expect(window.__cogniaSeedSkill).toBeUndefined()
    expect(window.__cogniaSeedConnectorDraft).toBeUndefined()
    expect(window.__cogniaSeedRun).toBeUndefined()
    expect(window.__cogniaSetMockBaseUrls).toBeUndefined()
    expect(window.__cogniaSaveCompanionConfig).toBeUndefined()
    expect(window.__cogniaSetSettings).toBeUndefined()
    expect(window.__cogniaTestGlobalsReady).toBeUndefined()
  })

  it("wires every helper when NEXT_PUBLIC_E2E === '1'", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    expect(typeof window.__cogniaResetDb).toBe("function")
    expect(typeof window.__cogniaSeedWorkflow).toBe("function")
    expect(typeof window.__cogniaSeedCharacter).toBe("function")
    expect(typeof window.__cogniaSeedTeam).toBe("function")
    expect(typeof window.__cogniaSeedSkill).toBe("function")
    expect(typeof window.__cogniaSeedConnectorDraft).toBe("function")
    expect(typeof window.__cogniaSeedRun).toBe("function")
    expect(typeof window.__cogniaSetMockBaseUrls).toBe("function")
    expect(typeof window.__cogniaSaveCompanionConfig).toBe("function")
    expect(typeof window.__cogniaClearCompanionConfig).toBe("function")
    expect(typeof window.__cogniaSetSettings).toBe("function")
  })

  it("removes every global on unmount", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    const { unmount } = render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    unmount()
    for (const k of cleanWindowKeys) {
      if (k === "__cogniaTestGlobalsReady") {
        expect(window.__cogniaTestGlobalsReady).toBe(false)
      } else {
        expect((window as unknown as Record<string, unknown>)[k as string]).toBeUndefined()
      }
    }
  })

  it("__cogniaSaveCompanionConfig persists to localStorage and clear removes it", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    await window.__cogniaSaveCompanionConfig!({
      baseUrl: "https://192.168.1.42:7891",
      deviceJwt: "tok.tok.tok",
      deviceId: "device_abc",
      serverVersion: "1.2.3",
    })
    const stored = window.localStorage.getItem("cognia.companion.config.v1")
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored!).baseUrl).toBe("https://192.168.1.42:7891")

    await window.__cogniaClearCompanionConfig!()
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()
  })

  it("__cogniaSetMockBaseUrls round-trips through localStorage", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    await window.__cogniaSetMockBaseUrls!({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
    })
    expect(window.__cogniaMockBaseUrls).toEqual({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
    })
    const raw = window.localStorage.getItem("cognia.e2e.mockBaseUrls.v1")
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).github).toBe("http://127.0.0.1:7893")

    // Merge semantics: a second call patches existing keys, doesn't replace.
    await window.__cogniaSetMockBaseUrls!({ lark: "http://127.0.0.1:7894" })
    expect(window.__cogniaMockBaseUrls).toEqual({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
      lark: "http://127.0.0.1:7894",
    })
  })
})
