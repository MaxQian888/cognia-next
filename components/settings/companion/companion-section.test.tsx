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
import {
  addPairedDevice,
  setLockedComputerUseAllowed,
  setRemoteControlAllowed,
  setRemoteTerminalAllowed,
} from "@/lib/db/paired-devices"
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
    // The table itself moved to `/devices`; what stays is the count and the
    // way in. Its own coverage lives in `components/devices/**`.
    expect(await screen.findByTestId("device-console-link-paired")).toBeInTheDocument()
    expect(screen.getByText(/No devices are paired/i)).toBeInTheDocument()
  })

  it("toggling the master switch calls companion_server_start", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "trusted-device",
      label: "Trusted Phone",
      platform: "ios",
      pubkey: "key",
      appVersion: "1.0.0",
      nowMs: Date.now(),
    })
    await setRemoteControlAllowed("trusted-device", true)
    await setLockedComputerUseAllowed("trusted-device", true)
    await setRemoteTerminalAllowed("trusted-device", true, {
      hostId: "host-1",
      issuedAt: Date.now(),
      signingPublicKey: "public-key",
      credentialKeyId: "credential-1",
      signature: "signature",
    })
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_server_start") {
        const a = args as { port: number; bindLoopbackOnly: boolean }
        expect(a.port).toBe(27890)
        expect(a.bindLoopbackOnly).toBe(true)
        return 27890
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable companion server/i)
    await user.click(toggle)

    await waitFor(() => {
      const callNames = callSpy.mock.calls.map((c) => c[0])
      expect(callNames).toContain("companion_server_start")
      expect(callSpy).toHaveBeenCalledWith("companion_seed_locked_computer_use", {
        deviceIds: ["trusted-device"],
      })
      // The three real grants are imported once into the host's SecurityStore
      // rather than re-projected onto an in-memory list at every boot — the
      // store is the authority and is already persistent.
      expect(callSpy).toHaveBeenCalledWith("companion_migrate_legacy_device_grants", {
        control: ["trusted-device"],
        agentControl: [],
        terminal: ["trusted-device"],
      })
      expect(callSpy.mock.calls.map((c) => c[0])).not.toContain("companion_seed_remote_terminal")
    })
  })

  it("clicking Generate QR calls companion_create_owner_invitation and shows the QR", async () => {
    const user = userEvent.setup()
    const futureMs = Date.now() + 5 * 60_000
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_create_owner_invitation") {
        return {
          invitation: "owner-invitation",
          expiresAtMs: futureMs,
          baseUrl: "http://192.168.1.42:7890",
          fingerprint: "sha256:paired-spki",
          appVersion: "0.1.0",
          hostId: "host-1",
          tenantId: "local_acct_a",
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const button = await screen.findByRole("button", { name: /Generate QR/i })
    await user.click(button)

    const qr = await screen.findByTestId("qr-mock")
    const value = qr.getAttribute("data-value") || ""
    // The offline cgnp3 schema is independent of the now-unversioned URLs.
    const decoded = decodePairPayload(value)
    expect(decoded.kind).toBe("ok")
    if (decoded.kind === "ok") {
      expect(decoded.payload.baseUrl).toBe("http://192.168.1.42:7890")
      expect(decoded.payload.invitation).toBe("owner-invitation")
      expect(decoded.payload.hostId).toBe("host-1")
      expect(decoded.payload.tenantId).toBe("local_acct_a")
      expect(decoded.payload.serverVersion).toBe("0.1.0")
      expect(decoded.payload.fingerprint).toBe("sha256:paired-spki")
    }
    // No argument. The Rust command resolves the tenant from the host binding;
    // an account id here would be an argument nothing reads, and
    // `audit:command-parity` only diffs command names so nothing else would
    // catch it.
    expect(callSpy).toHaveBeenCalledWith("companion_create_owner_invitation")
    expect(screen.getByText(/Expires in/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pair-code-block")).toBeNull()
  })

  it("does not issue a pair token while the local account is locked", async () => {
    const user = userEvent.setup()
    ;(useAccountStore.getState() as { unlockedAccountId: string | null }).unlockedAccountId = null

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))

    expect(callSpy.mock.calls.map((call) => call[0])).not.toContain(
      "companion_create_owner_invitation"
    )
  })

  it("renders an expired one-shot invitation without a QR", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_create_owner_invitation") {
        return {
          invitation: "expired-invitation",
          expiresAtMs: Date.now() - 1,
          baseUrl: "http://127.0.0.1:7890",
          fingerprint: "sha256:paired-spki",
          appVersion: "0.1.0",
          hostId: "host-1",
          tenantId: "local_acct_a",
        }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))

    expect(await screen.findByText(/Token expired/i)).toBeInTheDocument()
    expect(screen.queryByTestId("qr-mock")).toBeNull()
    expect(screen.queryByTestId("pair-code-block")).toBeNull()
  })

  it("handles invitation issue failures and can generate a fresh QR afterward", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_create_owner_invitation") return Promise.reject("pair failed")
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByRole("button", { name: /Generate QR/i }))
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_create_owner_invitation"))

    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_create_owner_invitation") {
        return {
          invitation: "fresh-invitation",
          expiresAtMs: Date.now() + 5 * 60_000,
          baseUrl: "http://192.168.1.42:7890",
          fingerprint: "sha256:paired-spki",
          appVersion: "0.1.0",
          hostId: "host-1",
          tenantId: "local_acct_a",
        }
      }
      return undefined as unknown as never
    })
    await user.click(screen.getByRole("button", { name: /Generate QR/i }))
    expect(await screen.findByTestId("qr-mock")).toBeInTheDocument()
  })

  /**
   * Row rendering, revoke, pause and resume all moved to the device console
   * with their behaviour intact — the biometric gating and the Dexie + Rust
   * dual write are covered by `hooks/devices/use-device-grant-actions.test.tsx`
   * and the surface by `components/devices/sections/access-section.test.tsx`.
   * What is asserted here is only that Settings reports the count.
   */
  it("reports how many devices are paired without listing them", async () => {
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
    expect(await screen.findByText(/2 devices are paired/i)).toBeInTheDocument()
    expect(screen.queryByText("Max's iPhone")).not.toBeInTheDocument()
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
        localUrl: "https://127.0.0.1:27890",
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
        port: 27890,
        appVersion: "0.1.0",
        tlsFingerprint: "sha256:fp",
      })
    )

    await user.click(toggle)
    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_mdns_stop"))
  })

  // -------------------------------------------------------------------------
  // Reachability preference
  //
  // The server and mDNS switches used to be pure session state: nothing wrote
  // them down and nothing restored them, so a phone that had auto-discovered
  // this desktop silently lost it on the next restart. These pin that each
  // intent surface records the choice for the Rust boot restore.
  // -------------------------------------------------------------------------

  /** The config from the last `companion_reachability_set`, or null. */
  function lastSavedPrefs(): Record<string, unknown> | null {
    const saves = callSpy.mock.calls.filter((call) => call[0] === "companion_reachability_set")
    const last = saves.at(-1)
    return last ? ((last[1] as { config: Record<string, unknown> }).config ?? null) : null
  }

  it("remembers the server binding so the next boot restores it", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      if (name === "companion_server_start") return 27890
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/Enable companion server/i))

    await waitFor(() =>
      expect(lastSavedPrefs()).toEqual({
        serverEnabled: true,
        port: 27890,
        bindLoopbackOnly: true,
        mdnsEnabled: false,
      })
    )
  })

  it("stops remembering the server once it is switched off", async () => {
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") {
        return { running: true, bindMode: "loopback" as const, boundPort: 27890 }
      }
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    const toggle = await screen.findByLabelText(/Enable companion server/i)
    await waitFor(() => expect(toggle).toBeChecked())
    await user.click(toggle)

    await waitFor(() => expect(callSpy).toHaveBeenCalledWith("companion_server_stop"))
    await waitFor(() => expect(lastSavedPrefs()).toMatchObject({ serverEnabled: false }))
  })

  it("persists a LAN binding chosen while the server is stopped", async () => {
    // The radio is the *desired* binding whether or not the server is running.
    // Picking LAN while stopped and enabling later must not come back on
    // loopback — which is what happens if the preference is only written on
    // the restart path.
    const user = userEvent.setup()
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_server_status") return STATUS_STOPPED
      return undefined as unknown as never
    })

    render(<CompanionSection />)
    await user.click(await screen.findByLabelText(/LAN \(phones on the same Wi-Fi\)/i))

    await waitFor(() => expect(lastSavedPrefs()).toMatchObject({ bindLoopbackOnly: false }))
    // Stopped: rebinding would be a no-op restart of a server that is not up.
    expect(callSpy.mock.calls.map((call) => call[0])).not.toContain("companion_server_start")
  })

  it("remembers the mDNS switch in both directions", async () => {
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
    await waitFor(() => expect(lastSavedPrefs()).toMatchObject({ mdnsEnabled: true }))

    await user.click(toggle)
    await waitFor(() => expect(lastSavedPrefs()).toMatchObject({ mdnsEnabled: false }))
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

  // The reachability probe moved into the channel matrix, which attributes each
  // result to a channel instead of printing a flat list of URLs. Its coverage
  // lives in channel-matrix-card.test.tsx.

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

  it("collapses Advanced by default and expands on click", async () => {
    const user = userEvent.setup()
    render(<CompanionSection />)
    // A default-open group renders immediately…
    await screen.findByText(/Mobile companion server/i)
    // …while the collapsed Advanced group keeps its cards unmounted.
    expect(screen.queryByText(/Sync status/i)).toBeNull()

    await user.click(screen.getByTestId("companion-group-trigger-advanced"))

    expect(await screen.findByText(/Sync status/i)).toBeInTheDocument()
  })

  it("leads the network group with the channel matrix", async () => {
    // The four channel cards each know only their own switch; the matrix is
    // the only place that answers "can anything reach this desktop, and how".
    render(<CompanionSection />)
    expect(await screen.findByTestId("channel-matrix-card")).toBeInTheDocument()
    for (const id of ["lan", "mdns", "tunnel", "webrtc"]) {
      expect(screen.getByTestId(`channel-row-${id}`)).toBeInTheDocument()
    }
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
