/**
 * Smoke + interaction coverage for the Mobile Companion settings section.
 *
 * Drives the top-level component end-to-end against fake-indexeddb. The
 * Tauri bridge is faked out by stubbing `__TAURI_INTERNALS__` so `isTauri()`
 * returns true and by spying on `transport.call` to return canned values.
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CompanionSection } from "./companion-section"
import enMessages from "@/i18n/messages/en.json"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addPairedDevice, listPairedDevices } from "@/lib/db/paired-devices"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { useAccountStore } from "@/stores/account/account-store"

jest.setTimeout(20_000)

jest.mock("@/stores/account/account-store", () => {
  const mockAccountStoreState = {
    unlockedAccountId: "local_acct_a" as string | null,
  }
  const useAccountStore = Object.assign(
    jest.fn((selector: (state: typeof mockAccountStoreState) => unknown) =>
      selector(mockAccountStoreState)
    ),
    {
      getState: () => mockAccountStoreState,
    }
  )
  return { useAccountStore }
})

// `qrcode.react` renders <canvas>; in jsdom that's stable but slow. We replace
// it with a marker element so the table tests don't pull canvas imageData.
jest.mock("qrcode.react", () => ({
  __esModule: true,
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr-mock" data-value={value} />,
}))

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

const STATUS_STOPPED = {
  running: false,
  bindMode: "none" as const,
  boundPort: null,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
  // Default: every call returns the stopped status. Individual tests
  // override per-call with mockImplementationOnce / mockResolvedValueOnce.
  ;(useAccountStore.getState() as { unlockedAccountId: string | null }).unlockedAccountId =
    "local_acct_a"
  callSpy.mockImplementation(async (name: string) => {
    if (name === "companion_server_status") return STATUS_STOPPED
    return undefined as unknown as never
  })
  // Subscribe is harmless to call but the live-query hook uses Dexie, not
  // transport — no need to stub it.
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("CompanionSection", () => {
  it("renders all three cards on mount", async () => {
    render(<CompanionSection />)
    expect(await screen.findByText(/Mobile companion server/i)).toBeInTheDocument()
    expect(screen.getByText(/Pair a new device/i)).toBeInTheDocument()
    expect(screen.getByText(/Paired devices/i)).toBeInTheDocument()
    // Empty state for the table
    expect(await screen.findByText(/No devices paired yet/i)).toBeInTheDocument()
  })

  it("toggling the master switch calls companion_server_start", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_server_start") {
        const a = args as { port: number; bindLoopbackOnly: boolean }
        expect(a.port).toBe(7890)
        expect(a.bindLoopbackOnly).toBe(true)
        return 7890
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable companion server/i)
    await user.click(toggle)

    await waitFor(() => {
      const callNames = callSpy.mock.calls.map((c) => c[0])
      expect(callNames).toContain("companion_server_start")
    })
  })

  it("clicking Generate QR calls companion_issue_pair_jwt and shows the QR", async () => {
    const user = userEvent.setup()
    const futureMs = Date.now() + 5 * 60_000
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") {
        return {
          pairJwt: "header.payload.signature",
          expiresAtMs: futureMs,
          baseUrl: "http://192.168.1.42:7890",
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const button = await screen.findByRole("button", { name: /Generate QR/i })
    await user.click(button)

    const qr = await screen.findByTestId("qr-mock")
    const value = qr.getAttribute("data-value") || ""
    // Wave 1.7 v2 payload: `cgnp2|<base64url>`. Decode through the
    // canonical helper so the test is implementation-agnostic.
    const decoded = decodePairPayload(value)
    expect(decoded.kind).toBe("ok")
    if (decoded.kind === "ok") {
      expect(decoded.payload.baseUrl).toBe("http://192.168.1.42:7890")
      expect(decoded.payload.pairJwt).toBe("header.payload.signature")
      expect(decoded.payload.version).toBe("0.1.0")
    }
    expect(callSpy).toHaveBeenCalledWith("companion_issue_pair_jwt", {
      localAccountId: "local_acct_a",
    })
    expect(screen.getByText(/Expires in/i)).toBeInTheDocument()
    // Legacy desktops (no pair code) — block must NOT render.
    expect(screen.queryByTestId("pair-code-block")).toBeNull()
  })

  it("does not issue a pair token while the local account is locked", async () => {
    const user = userEvent.setup()
    ;(useAccountStore.getState() as { unlockedAccountId: string | null }).unlockedAccountId = null

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))

    expect(callSpy.mock.calls.map((call) => call[0])).not.toContain("companion_issue_pair_jwt")
  })

  it("renders an expired pairing issue without a QR and disables code copy", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") {
        return {
          pairJwt: "header.payload.signature",
          expiresAtMs: Date.now() - 1,
          baseUrl: "http://127.0.0.1:7890",
          pairCode: "123456",
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))

    expect(await screen.findByText(/Token expired/i)).toBeInTheDocument()
    expect(screen.queryByTestId("qr-mock")).toBeNull()
    expect(screen.getByTestId("pair-code-block")).toHaveAttribute("data-expired", "true")
    expect(screen.getByTestId("pair-code-copy")).toBeDisabled()
  })

  it("renders the 6-digit code block alongside the QR when the desktop returns one", async () => {
    const user = userEvent.setup()
    const futureMs = Date.now() + 5 * 60_000
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") {
        return {
          pairJwt: "header.payload.signature",
          expiresAtMs: futureMs,
          baseUrl: "http://192.168.1.42:7890",
          pairCode: "742518",
          pairCodeExpiresAtMs: futureMs,
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const button = await screen.findByRole("button", { name: /Generate QR/i })
    await user.click(button)

    const block = await screen.findByTestId("pair-code-block")
    expect(block.getAttribute("data-expired")).toBe("false")
    expect(screen.getByTestId("pair-code-digits")).toHaveTextContent("742518")
    expect(screen.getByTestId("pair-code-copy")).toBeInTheDocument()
  })

  it("copies the pairing code through the Clipboard API when available", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const futureMs = Date.now() + 5 * 60_000
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") {
        return {
          pairJwt: "header.payload.signature",
          expiresAtMs: futureMs,
          baseUrl: "http://192.168.1.42:7890",
          pairCode: "742518",
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))
    await user.click(await screen.findByTestId("pair-code-copy"))

    expect(writeText).toHaveBeenCalledWith("742518")
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument()
  })

  it("handles pairing issue failures and clipboard write failures", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn<Promise<void>, [string]>().mockRejectedValueOnce(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") return Promise.reject("pair failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_issue_pair_jwt", {
        localAccountId: "local_acct_a",
      })
    )

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_issue_pair_jwt") {
        return {
          pairJwt: "header.payload.signature",
          expiresAtMs: Date.now() + 5 * 60_000,
          baseUrl: "http://192.168.1.42:7890",
          pairCode: "123456",
        }
      }
      return undefined as unknown as never
    })
    await user.click(screen.getByRole("button", { name: /Generate QR/i }))
    await user.click(await screen.findByTestId("pair-code-copy"))
    expect(writeText).toHaveBeenCalledWith("123456")
  })

  it("renders rows from listPairedDevices via useLiveQuery", async () => {
    await addPairedDevice({
      deviceId: "dev-1",
      label: "Max's iPhone",
      platform: "ios",
      pubkey: "k1",
      appVersion: "0.1.0",
      nowMs: Date.now() - 5 * 60_000,
    })
    await addPairedDevice({
      deviceId: "dev-2",
      label: "Pixel 8",
      platform: "android",
      pubkey: "k2",
      appVersion: "0.1.0",
      nowMs: Date.now() - 60_000,
    })

    render(<CompanionSection />)
    expect(await screen.findByText("Max's iPhone")).toBeInTheDocument()
    expect(screen.getByText("Pixel 8")).toBeInTheDocument()
  })

  it("revoking a device calls both Dexie and the Rust deny-list", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-1",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    const revokeIds: string[] = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_revoke_device") {
        revokeIds.push((args as { deviceId: string }).deviceId)
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const revokeBtn = await screen.findByRole("button", {
      name: /Revoke Phone/i,
    })
    await user.click(revokeBtn)

    await waitFor(() => {
      expect(revokeIds).toEqual(["dev-1"])
    })
    const rows = await listPairedDevices()
    expect(rows[0]?.revokedAt).toBeDefined()
  })

  it("pausing a device routes through the same biometric guard as revoke", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-pause",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    const revokeIds: string[] = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_revoke_device") {
        revokeIds.push((args as { deviceId: string }).deviceId)
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const pauseBtn = await screen.findByRole("button", { name: /Pause Phone/i })
    await user.click(pauseBtn)

    // The guard's `fallthroughWhenUnavailable` default lets pause complete
    // when no biometric is enrolled (jsdom). The Rust deny-list write must
    // still fire — that's the bit a stolen-unlocked-desktop attacker uses.
    await waitFor(() => {
      expect(revokeIds).toEqual(["dev-pause"])
    })
    const rows = await listPairedDevices()
    expect(rows[0]?.pausedAt).toBeDefined()
    expect(rows[0]?.revokedAt).toBeUndefined()
  })

  it("resuming a paused device clears the deny-list entry", async () => {
    const user = userEvent.setup()
    const now = Date.now()
    await addPairedDevice({
      deviceId: "dev-resume",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: now - 60_000,
    })
    // Put the row in the paused state up-front so the Resume button renders.
    const db = getDb()
    await db.table("pairedDevices").update("dev-resume", { pausedAt: now })

    const unrevokeIds: string[] = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_unrevoke_device") {
        unrevokeIds.push((args as { deviceId: string }).deviceId)
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const resumeBtn = await screen.findByRole("button", { name: /Resume Phone/i })
    await user.click(resumeBtn)

    await waitFor(() => {
      expect(unrevokeIds).toEqual(["dev-resume"])
    })
    const rows = await listPairedDevices()
    expect(rows[0]?.pausedAt).toBeUndefined()
  })

  it("renders 'No devices paired yet' empty state when the table is empty", async () => {
    render(<CompanionSection />)
    expect(await screen.findByText(/No devices paired yet/i)).toBeInTheDocument()
  })

  it("shows a LAN HTTPS notice when running with bindMode=lan", async () => {
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") {
        return { running: true, bindMode: "lan" as const, boundPort: 7890 }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    // The card replaced the V1 "Plain HTTP" warning with a self-signed HTTPS
    // status row once TLS landed; the role downgraded to "status" since it
    // describes a benign cert-pinning behavior rather than an insecure mode.
    expect(await screen.findByRole("status", { name: undefined })).toHaveTextContent(
      /Self-signed HTTPS/i
    )
  })

  it("changing bind mode while running rebinds the server", async () => {
    const user = userEvent.setup()
    let currentMode: "loopback" | "lan" | "none" = "loopback"
    let port = 7890
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") {
        return {
          running: currentMode !== "none",
          bindMode: currentMode,
          boundPort: currentMode === "none" ? null : port,
        }
      }
      if (name === "companion_server_stop") {
        currentMode = "none"
        return undefined as unknown as never
      }
      if (name === "companion_server_start") {
        const a = args as { bindLoopbackOnly: boolean }
        currentMode = a.bindLoopbackOnly ? "loopback" : "lan"
        port = 7890
        return port
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    // Wait for the initial status to populate.
    await screen.findByText(/Listening on/i)

    const lanRadio = screen.getByLabelText(/LAN \(phones on the same Wi-Fi\)/i)
    await user.click(lanRadio)

    await waitFor(() => {
      const names = callSpy.mock.calls.map((c) => c[0])
      expect(names).toContain("companion_server_stop")
      expect(names).toContain("companion_server_start")
    })
  })

  it("stops a running companion server from the master switch", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") {
        return { running: true, bindMode: "loopback" as const, boundPort: 7890 }
      }
      if (name === "companion_server_stop") return undefined as unknown as never
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable companion server/i)
    await user.click(toggle)

    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_server_stop"))
  })

  it("keeps rendering when the companion status fetch fails", async () => {
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return Promise.reject("status failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)

    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_server_status"))
    expect(screen.getByText(/Mobile companion server/i)).toBeInTheDocument()
  })

  it("keeps a stopped server stopped when bind mode changes", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/LAN \(phones on the same Wi-Fi\)/i))

    expect(callSpy.mock.calls.map((call) => call[0])).not.toContain("companion_server_start")
  })

  it("surfaces companion server start and rebind failures without flipping state", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string, _args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_server_start") throw new Error("start failed")
      return undefined as unknown as never
    })

    const first = render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable companion server/i))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_server_start", expect.anything())
    )
    first.unmount()

    let currentMode: "loopback" | "lan" | "none" = "loopback"
    callSpy.mockImplementation(async (name: string, _args?: unknown) => {
      if (name === "companion_server_status") {
        return { running: true, bindMode: currentMode, boundPort: 7890 }
      }
      if (name === "companion_server_stop") {
        currentMode = "none"
        return undefined as unknown as never
      }
      if (name === "companion_server_start") throw new Error("rebind failed")
      return undefined as unknown as never
    })
    render(<CompanionSection />)
    await screen.findByText(/Listening on/i)
    await user.click(screen.getByLabelText(/LAN \(phones on the same Wi-Fi\)/i))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_server_start", expect.anything())
    )
  })

  it("saving a named tunnel clears the token field and shows the configured badge", async () => {
    const user = userEvent.setup()
    let saved = false
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") {
        return saved
          ? { mode: "named", hostname: "https://c.example.com", hasToken: true }
          : { mode: "named", hostname: "", hasToken: false }
      }
      if (name === "companion_tunnel_save_named_config") {
        saved = true
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    // Named-mode form lives in the (default-open) Server & network group.
    const hostname = await screen.findByLabelText(/Public hostname/i)
    const token = screen.getByLabelText(/Connector token/i)
    await user.type(hostname, "https://c.example.com")
    await user.type(token, "eyJsecret")
    await user.click(screen.getByRole("button", { name: /^Save$/i }))

    // Token is a write-only secret — the field must clear on success so the
    // populated password box doesn't imply it still holds the saved value.
    await waitFor(() => expect((token as HTMLInputElement).value).toBe(""))
    // The configured badge is the source-of-truth signal, not just a toast.
    expect(await screen.findByTestId("tunnel-token-configured")).toBeInTheDocument()
  })

  it("starts and stops the quick tunnel from the switch", async () => {
    const user = userEvent.setup()
    let tunnelRunning = false
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") {
        return tunnelRunning
          ? { publicUrl: "https://quick.example.com", localUrl: "https://127.0.0.1:7890" }
          : null
      }
      if (name === "companion_tunnel_get_config") {
        return { mode: "quick", hasToken: false }
      }
      if (name === "companion_tunnel_start") {
        tunnelRunning = true
        return { publicUrl: "https://quick.example.com", localUrl: "https://127.0.0.1:7890" }
      }
      if (name === "companion_tunnel_stop") {
        tunnelRunning = false
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable cloudflared tunnel/i)
    await user.click(toggle)
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_start", {
        localUrl: "https://127.0.0.1:7890",
      })
    )

    await user.click(toggle)
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_tunnel_stop"))
  })

  it("switches tunnel mode back to quick and stops any running tunnel", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") {
        return { publicUrl: "https://named.example.com", localUrl: "https://127.0.0.1:7890" }
      }
      if (name === "companion_tunnel_get_config") {
        return { mode: "named", hostname: "https://named.example.com", hasToken: true }
      }
      if (name === "companion_tunnel_set_mode" || name === "companion_tunnel_stop") {
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Quick \(random URL\)/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_set_mode", { mode: "quick" })
    )
    expect(callSpy).toHaveBeenCalledWith("companion_tunnel_stop")
  })

  it("surfaces cloudflared launch failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      if (name === "companion_tunnel_start") throw new Error("cloudflared not found")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable cloudflared tunnel/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_start", expect.anything())
    )
  })

  it("handles named tunnel save and clear failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") {
        return { mode: "named", hostname: "https://c.example.com", hasToken: true }
      }
      if (name === "companion_tunnel_save_named_config") return Promise.reject("save failed")
      if (name === "companion_tunnel_clear_named") throw new Error("clear failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const hostname = await screen.findByLabelText(/Public hostname/i)
    const token = screen.getByLabelText(/Connector token/i)
    await user.clear(hostname)
    await user.type(hostname, "https://c.example.com")
    await user.type(token, "eyJsecret")
    await user.click(screen.getByRole("button", { name: /^Save$/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_save_named_config", {
        token: "eyJsecret",
        hostname: "https://c.example.com",
      })
    )

    await user.click(screen.getByLabelText(/Clear named tunnel configuration/i))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_tunnel_clear_named"))
  })

  it("surfaces generic tunnel launch failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      if (name === "companion_tunnel_start") throw new Error("launch failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable cloudflared tunnel/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_start", expect.anything())
    )
  })

  it("surfaces non-Error tunnel launch failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      if (name === "companion_tunnel_start") return Promise.reject("launch failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable cloudflared tunnel/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_tunnel_start", expect.anything())
    )
  })

  it("clears a named tunnel configuration", async () => {
    const user = userEvent.setup()
    let cleared = false
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") {
        return cleared
          ? { mode: "named", hostname: "", hasToken: false }
          : { mode: "named", hostname: "https://c.example.com", hasToken: true }
      }
      if (name === "companion_tunnel_clear_named") {
        cleared = true
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await screen.findByTestId("tunnel-token-configured")
    await user.click(screen.getByLabelText(/Clear named tunnel configuration/i))

    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_tunnel_clear_named"))
    expect(screen.queryByTestId("tunnel-token-configured")).toBeNull()
  })

  it("starts and stops mDNS broadcasting with the TLS fingerprint", async () => {
    const user = userEvent.setup()
    let running = false
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_mdns_status") return running
      if (name === "companion_get_tls_fingerprint") return "sha256:fp"
      if (name === "companion_mdns_start") {
        running = true
        return "ok"
      }
      if (name === "companion_mdns_stop") {
        running = false
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable mDNS broadcast/i)
    await user.click(toggle)
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_mdns_start", {
        port: 7890,
        appVersion: "0.1.0",
        tlsFingerprint: "sha256:fp",
      })
    )

    await user.click(toggle)
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_mdns_stop"))
  })

  it("surfaces mDNS start failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_mdns_status") return false
      if (name === "companion_get_tls_fingerprint") return "sha256:fp"
      if (name === "companion_mdns_start") throw new Error("mdns failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable mDNS broadcast/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_mdns_start", expect.anything())
    )
  })

  it("surfaces non-Error mDNS start failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_mdns_status") return false
      if (name === "companion_get_tls_fingerprint") return "sha256:fp"
      if (name === "companion_mdns_start") return Promise.reject("mdns failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable mDNS broadcast/i))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_mdns_start", expect.anything())
    )
  })

  it("runs reachability diagnostics and renders reachable and failed rows", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_test_local_reachability") {
        return [
          { url: "https://127.0.0.1:7890", reachable: true, latencyMs: 12 },
          { url: "https://192.168.1.10:7890", reachable: false, error: "timeout" },
        ]
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(screen.getByTestId("companion-group-trigger-advanced"))
    await user.click(await screen.findByRole("button", { name: /Test reachability/i }))

    expect(await screen.findByText("https://127.0.0.1:7890")).toBeInTheDocument()
    expect(screen.getByText("https://192.168.1.10:7890")).toBeInTheDocument()
    expect(screen.getByText(/timeout/i)).toBeInTheDocument()
  })

  it("handles diagnostics command failures and sparse rows", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_test_local_reachability") {
        return [
          { url: "https://127.0.0.1:7890", reachable: true },
          { url: "https://192.168.1.10:7890", reachable: false },
        ]
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(screen.getByTestId("companion-group-trigger-advanced"))
    await user.click(await screen.findByRole("button", { name: /Test reachability/i }))
    expect(await screen.findByText("https://127.0.0.1:7890")).toBeInTheDocument()
    expect(screen.getByText(/Failed/i)).toBeInTheDocument()

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_test_local_reachability") return Promise.reject("probe failed")
      return undefined as unknown as never
    })
    await user.click(screen.getByRole("button", { name: /Test reachability/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenLastCalledWith("companion_test_local_reachability")
    )
  })

  it("configures and clears push notification credentials", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_push_status") {
        return { fcmConfigured: true, apnsConfigured: true }
      }
      if (
        name === "companion_push_configure_fcm" ||
        name === "companion_push_clear_fcm" ||
        name === "companion_push_configure_apns" ||
        name === "companion_push_clear_apns"
      ) {
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await screen.findAllByText(/configured/i)

    fireEvent.change(screen.getByLabelText(/FCM service-account JSON/i), {
      target: { value: '{"type":"service_account"}' },
    })
    await user.click(screen.getByRole("button", { name: /Save FCM/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_push_configure_fcm", {
        serviceAccountJson: '{"type":"service_account"}',
      })
    )
    await user.click(screen.getByRole("button", { name: /Clear FCM/i }))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_push_clear_fcm"))

    await user.type(screen.getByPlaceholderText("ABC1234DEF"), "KEY123")
    await user.type(screen.getByPlaceholderText("TEAM1234DE"), "TEAM123")
    const bundle = screen.getByPlaceholderText("com.cognia.mobile")
    await user.clear(bundle)
    await user.type(bundle, "com.cognia.test")
    await user.type(screen.getByLabelText(/APNs \.p8 private key/i), "-----BEGIN PRIVATE KEY-----")
    await user.click(screen.getByLabelText(/APNs production environment/i))
    await user.click(screen.getByRole("button", { name: /Save APNs/i }))

    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_push_configure_apns", {
        keyId: "KEY123",
        teamId: "TEAM123",
        bundleId: "com.cognia.test",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----",
        production: true,
      })
    )
    await user.click(screen.getByRole("button", { name: /Clear APNs/i }))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_push_clear_apns"))
  })

  it("handles push validation and command failures", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_push_status") return { fcmConfigured: true, apnsConfigured: true }
      if (name === "companion_push_configure_fcm") return Promise.reject("fcm failed")
      if (name === "companion_push_clear_fcm") return Promise.reject("clear fcm failed")
      if (name === "companion_push_configure_apns") return Promise.reject("apns failed")
      if (name === "companion_push_clear_apns") return Promise.reject("clear apns failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await screen.findAllByText(/configured/i)

    await user.click(screen.getByRole("button", { name: /Save FCM/i }))
    fireEvent.change(screen.getByLabelText(/FCM service-account JSON/i), {
      target: { value: '{"type":"service_account"}' },
    })
    await user.click(screen.getByRole("button", { name: /Save FCM/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_push_configure_fcm", expect.anything())
    )
    await user.click(screen.getByRole("button", { name: /Clear FCM/i }))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_push_clear_fcm"))

    await user.click(screen.getByRole("button", { name: /Save APNs/i }))
    await user.type(screen.getByPlaceholderText("ABC1234DEF"), "KEY123")
    await user.type(screen.getByPlaceholderText("TEAM1234DE"), "TEAM123")
    await user.type(screen.getByLabelText(/APNs \.p8 private key/i), "-----BEGIN PRIVATE KEY-----")
    await user.click(screen.getByRole("button", { name: /Save APNs/i }))
    await waitFor(() =>
      expect(callSpy).toHaveBeenCalledWith("companion_push_configure_apns", expect.anything())
    )
    await user.click(screen.getByRole("button", { name: /Clear APNs/i }))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_push_clear_apns"))
  })

  it("handles push status load failures", async () => {
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_push_status") return Promise.reject("status failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)

    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_push_status"))
  })

  it("collapses Advanced & diagnostics by default and expands on click", async () => {
    const user = userEvent.setup()
    render(<CompanionSection />)
    // A default-open group renders immediately…
    await screen.findByText(/Mobile companion server/i)
    // …while the collapsed Advanced group keeps its cards unmounted.
    expect(screen.queryByText(/Connection diagnostics/i)).toBeNull()
    expect(screen.queryByText(/Sync status/i)).toBeNull()

    await user.click(screen.getByTestId("companion-group-trigger-advanced"))

    expect(await screen.findByText(/Connection diagnostics/i)).toBeInTheDocument()
    expect(screen.getByText(/Sync status/i)).toBeInTheDocument()
  })

  it("routes the APNs example placeholders through i18n", async () => {
    render(<CompanionSection />)
    const push = enMessages.mobile.companion.push
    expect(await screen.findByPlaceholderText(push.apnsKeyIdPlaceholder)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(push.apnsTeamIdPlaceholder)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(push.apnsBundleIdPlaceholder)).toBeInTheDocument()
  })
})

// ─── Web-mode degradation ─────────────────────────────────────────────────────

describe("CompanionSection (web mode)", () => {
  beforeEach(() => {
    setTauri(false)
  })

  it("renders the desktop-only hint when not running in Tauri", async () => {
    render(<CompanionSection />)
    expect(
      await screen.findByText(/Companion server runs in the desktop process/i)
    ).toBeInTheDocument()
  })
})
