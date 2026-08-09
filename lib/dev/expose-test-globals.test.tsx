/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { render, waitFor, cleanup } from "@testing-library/react"
import { ExposeTestGlobals } from "./expose-test-globals"
import { getDb } from "@/lib/db/schema"
import {
  __resetBrowserVaultForTesting,
  deleteBrowserVault,
  provisionBrowserVault,
} from "@/lib/runtime/browser-vault"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { __setRuntimeTargetRegistrarForTests } from "@/lib/tauri/transport-companion"

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
  "__cogniaE2ECompanion",
  "__cogniaSetSettings",
  "__cogniaE2EWebRtc",
  "__cogniaE2EWebRtcEvents",
  "__cogniaE2EWebRtcReady",
  "__cogniaTestGlobalsReady",
] as Array<keyof Window>

beforeEach(() => {
  for (const k of cleanWindowKeys) {
    delete (window as unknown as Record<string, unknown>)[k as string]
  }
  delete window.__cogniaPluginRuntimeReady
  window.localStorage.clear()
})

afterEach(async () => {
  cleanup()
  __setRuntimeTargetRegistrarForTests(null)
  clearActiveRuntimeTargetContext()
  await deleteBrowserVault("acct_e2e_vault").catch(() => undefined)
  __resetBrowserVaultForTesting()
  delete window.__cogniaPluginRuntimeReady
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
    expect(typeof window.__cogniaE2ECompanion?.call).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.request).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.subscribe).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.pair).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.targets).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.switchTarget).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.runtime).toBe("function")
    expect(window.__cogniaE2ECompanion?.activeTier()).toBeNull()
    expect(typeof window.__cogniaSetSettings).toBe("function")
    // ADR-0021 real-pair harness seam.
    expect(typeof window.__cogniaE2EWebRtc?.connect).toBe("function")
    expect(typeof window.__cogniaE2EWebRtc?.reconnectNow).toBe("function")
    expect(window.__cogniaE2EWebRtcEvents).toEqual({})
  })

  it("waits for an in-progress plugin schema upgrade before opening the fixture bridge", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    window.__cogniaPluginRuntimeReady = false

    render(<ExposeTestGlobals />)

    await waitFor(() => {
      expect(window.__cogniaE2EWebRtcReady).toBe(true)
    })
    expect(window.__cogniaTestGlobalsReady).not.toBe(true)

    window.__cogniaPluginRuntimeReady = true
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
  })

  it("__cogniaE2EWebRtc.getState returns 'idle' before connect and reconnectNow returns 'no-instance'", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    // No handshake started yet — the seam reports a benign default rather than
    // throwing, so the driver can poll state before connect().
    expect(window.__cogniaE2EWebRtc!.getState()).toBe("idle")
    expect(window.__cogniaE2EWebRtc!.reconnectNow()).toBe("no-instance")
  })

  it("seeds a sendable connector draft with canonical segments and preview", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })

    const id = await window.__cogniaSeedConnectorDraft!({
      adapterId: "adapter-e2e",
      conversationKey: "lark:adapter-e2e:chat-e2e",
      content: "Pending reply",
    })
    const row = await getDb().connectorDrafts.get(id)

    expect(row).toMatchObject({
      id,
      conversationKey: "lark:adapter-e2e:chat-e2e",
      segments: [{ type: "text", text: "Pending reply" }],
      status: "pending",
      outboundPreview: {
        conversationRef: {
          platform: "lark",
          adapterId: "adapter-e2e",
          chatId: "chat-e2e",
        },
        segments: [{ type: "text", text: "Pending reply" }],
        metadata: { idempotencyKey: expect.any(String) },
      },
    })
  })

  it("removes every global on unmount", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    const { unmount } = render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    unmount()
    for (const k of cleanWindowKeys) {
      if (k === "__cogniaTestGlobalsReady" || k === "__cogniaE2EWebRtcReady") {
        expect((window as unknown as Record<string, unknown>)[k]).toBe(false)
      } else {
        expect((window as unknown as Record<string, unknown>)[k as string]).toBeUndefined()
      }
    }
  })

  it("__cogniaSaveCompanionConfig persists only public target data outside the Browser Vault", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    setActiveRuntimeTargetContext("acct_e2e_vault", "standalone-local")
    __setRuntimeTargetRegistrarForTests(async (config) => {
      setActiveRuntimeTargetContext("acct_e2e_vault", config.targetId!)
    })
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    await window.__cogniaSaveCompanionConfig!({
      baseUrl: "https://192.168.1.42:7891",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "device_abc",
      serverVersion: "1.2.3",
    })
    const stored = window.localStorage.getItem("cognia.companion.hosts.v2")
    expect(stored).not.toBeNull()
    expect(stored).toContain("https://192.168.1.42:7891")
    expect(stored).not.toContain("device-private")
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()

    await window.__cogniaClearCompanionConfig!()
    expect(window.localStorage.getItem("cognia.companion.hosts.v2") ?? "").not.toContain(
      "https://192.168.1.42:7891"
    )
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
