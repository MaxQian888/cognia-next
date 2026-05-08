/**
 * Smoke + interaction coverage for the Mobile Companion settings section.
 *
 * Drives the top-level component end-to-end against fake-indexeddb. The
 * Tauri bridge is faked out by stubbing `__TAURI_INTERNALS__` so `isTauri()`
 * returns true and by spying on `transport.call` to return canned values.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CompanionSection } from "./companion-section"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addPairedDevice, listPairedDevices } from "@/lib/db/paired-devices"

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
    const parsed = JSON.parse(value) as Record<string, string>
    expect(parsed.baseUrl).toBe("http://192.168.1.42:7890")
    expect(parsed.pair_jwt).toBe("header.payload.signature")
    expect(parsed.server_version).toBe("0.1.0")
    expect(screen.getByText(/Expires in/i)).toBeInTheDocument()
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

  it("renders 'No devices paired yet' empty state when the table is empty", async () => {
    render(<CompanionSection />)
    expect(await screen.findByText(/No devices paired yet/i)).toBeInTheDocument()
  })

  it("shows a LAN warning when running with bindMode=lan", async () => {
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") {
        return { running: true, bindMode: "lan" as const, boundPort: 7890 }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    expect(await screen.findByRole("alert", { name: undefined })).toHaveTextContent(/Plain HTTP/i)
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
