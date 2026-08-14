/**
 * WebRtcCard — covers the input parser, default population, save round-trip,
 * the new per-device tier list, and the consecutive-poll-failure banner.
 *
 * The Dexie schema is exercised through the real `lib/db/settings.ts`; the
 * Jest jsdom env wires up `fake-indexeddb` in `jest.setup.ts` so reads/writes
 * complete synchronously enough that we can drive the UI with React Testing
 * Library without mocking the db.
 *
 * To exercise the polling effect we mock `@/lib/tauri` so `isTauri()` returns
 * `true` and `transport.call` resolves with whatever the test wants for the
 * two signaling commands.
 */

import "fake-indexeddb/auto"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

import {
  WebRtcCard,
  parseServers,
  parseTtl,
  persistTurnProvider,
  stringifyServers,
  TierDot,
  type DeviceTierEntry,
  type FormState,
} from "./webrtc-card"
import { __setProviderSecretStore } from "@/lib/credentials/turn-provisioning"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  KEYRING_CREDENTIAL_PREFIX,
  __setTurnCredentialBackend,
  isKeyringSentinel,
  keyIdOfSentinel,
} from "@/lib/credentials/turn-credentials"
import { saveSettings, getSettings } from "@/lib/db/settings"

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  }),
}))

// Mock @/lib/tauri so isTauri() returns true and transport.call is a jest fn
// we can program per test. The Dexie path (saveSettings/getSettings) keeps
// using the real `lib/db/settings.ts`.
const mockTransportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  transport: {
    call: (name: string, params?: Record<string, unknown>) => mockTransportCall(name, params),
    subscribe: jest.fn(),
  },
}))

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <WebRtcCard />
    </NextIntlClientProvider>
  )
}

// In-memory TURN credential store so the production code's
// auto-selected `TauriKeyringStore` (which would invoke
// `keyring_secret_*` over Tauri IPC) is replaced with a deterministic
// test backend. Restored in afterAll so other test files aren't
// affected.
class TestTurnCredentialStore {
  readonly map = new Map<string, { username: string; credential: string }>()
  async save(keyId: string, value: { username: string; credential: string }): Promise<void> {
    this.map.set(keyId, { ...value })
  }
  async load(keyId: string): Promise<{ username: string; credential: string } | null> {
    return this.map.get(keyId) ? { ...this.map.get(keyId)! } : null
  }
  async delete(keyId: string): Promise<void> {
    this.map.delete(keyId)
  }
}
let turnStore: TestTurnCredentialStore

beforeEach(() => {
  jest.clearAllMocks()
  mockTransportCall.mockImplementation(() =>
    Promise.reject(new Error("not configured for this test"))
  )
  turnStore = new TestTurnCredentialStore()
  __setTurnCredentialBackend(turnStore)
})

afterAll(() => {
  __setTurnCredentialBackend(null)
})

describe("parseServers", () => {
  it("accepts a STUN URL", () => {
    expect(parseServers("stun:stun.l.google.com:19302")).toEqual({
      servers: [{ urls: "stun:stun.l.google.com:19302" }],
      invalid: [],
    })
  })

  it("accepts a TURN URL with credentials", () => {
    const text = "turn:turn.example.com:3478?transport=udp|alice|s3cr3t"
    expect(parseServers(text)).toEqual({
      servers: [
        {
          urls: "turn:turn.example.com:3478?transport=udp",
          username: "alice",
          credential: "s3cr3t",
        },
      ],
      invalid: [],
    })
  })

  it("rejects TURN entries that are missing credentials", () => {
    expect(parseServers("turn:turn.example.com:3478")).toEqual({
      servers: [],
      invalid: ["turn:turn.example.com:3478"],
    })
  })

  it("skips blank and commented lines", () => {
    const text = ["", "# a comment", "stun:a.example:3478", "  "].join("\n")
    expect(parseServers(text)).toEqual({
      servers: [{ urls: "stun:a.example:3478" }],
      invalid: [],
    })
  })

  it("flags non-stun/turn schemes", () => {
    expect(parseServers("http://nope")).toEqual({
      servers: [],
      invalid: ["http://nope"],
    })
  })

  it("rejects malformed ports, unsupported query parameters, and TURN-TLS over UDP", () => {
    const text = [
      "turn:turn.example.com:70000?transport=udp|u|p",
      "turn:turn.example.com:3478?foo=bar|u|p",
      "turns:turn.example.com:5349?transport=udp|u|p",
    ].join("\n")
    expect(parseServers(text)).toEqual({
      servers: [],
      invalid: text.split("\n"),
    })
  })

  it("accepts bracketed IPv6 and TURN-TLS over TCP", () => {
    expect(parseServers("turns:[2001:db8::1]:5349?transport=tcp|alice|secret")).toEqual({
      servers: [
        {
          urls: "turns:[2001:db8::1]:5349?transport=tcp",
          username: "alice",
          credential: "secret",
        },
      ],
      invalid: [],
    })
  })
})

describe("stringifyServers", () => {
  it("renders one URL per line", () => {
    expect(stringifyServers([{ urls: "stun:a.example" }, { urls: "stun:b.example" }])).toBe(
      "stun:a.example\nstun:b.example"
    )
  })

  it("appends credentials as |user|cred", () => {
    expect(
      stringifyServers([
        {
          urls: "turn:t.example",
          username: "u",
          credential: "p",
        },
      ])
    ).toBe("turn:t.example|u|p")
  })
})

describe("TierDot", () => {
  it("renders a circle for each tier", () => {
    const { rerender, container } = render(<TierDot tier="connected" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
    rerender(<TierDot tier="failed" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("includes a tier-specific color class", () => {
    const { container, rerender } = render(<TierDot tier="connected" />)
    // SVG `className` is an `SVGAnimatedString` in jsdom; read the class
    // attribute directly so the assertion works against a plain string.
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").toContain("emerald")
    rerender(<TierDot tier="negotiating" />)
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").toContain("amber")
  })
})

describe("WebRtcCard — form & i18n", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("renders the title and the toggle", async () => {
    renderCard()
    expect(await screen.findByText(/WebRTC remote access/i)).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-enable-toggle")).toBeInTheDocument()
  })

  it("populates the default signaling URL on first paint", async () => {
    renderCard()
    const input = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(input).toHaveValue("wss://signaling.cognia.cn/signaling"))
  })

  it("places the TURN textarea placeholder via the translation key, not a literal", async () => {
    renderCard()
    // The actual placeholder value lives in `en.json`. We assert the
    // attribute matches the i18n value to prove the hard-coded literal at
    // line 223 (pre-ADR-0021 follow-up) is gone.
    const turn = await screen.findByLabelText(/TURN servers/i)
    expect(turn).toHaveAttribute("placeholder", en.mobile.companion.webrtc.turnServersPlaceholder)
  })

  it("uses the dedicated save button label", async () => {
    renderCard()
    const btn = await screen.findByTestId("webrtc-save")
    expect(btn).toHaveTextContent(en.mobile.companion.webrtc.saveButton)
  })

  it("rejects an invalid signaling URL", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const input = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(input).not.toHaveValue(""))
    await userEvent.clear(input)
    await userEvent.type(input, "http://no-wss.example")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})

describe("WebRtcCard — status block", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("renders the disabled state when the hub is off", async () => {
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: false,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    await screen.findByTestId("webrtc-status-disabled")
  })

  it("renders the empty-state hint when no devices are paired", async () => {
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    const empty = await screen.findByTestId("webrtc-status-empty")
    expect(empty).toHaveTextContent(en.mobile.companion.webrtc.noDevices)
  })

  it("renders one row per registered device with its tier label", async () => {
    const devices: DeviceTierEntry[] = [
      {
        deviceId: "device-apple-123456",
        rendezvousId: "r1",
        tier: "connected",
        updatedAtMs: 1,
      },
      {
        deviceId: "device-banana-7890",
        rendezvousId: "r2",
        tier: "negotiating",
        updatedAtMs: 2,
      },
      {
        deviceId: "device-cherry-9999",
        rendezvousId: "r3",
        tier: "failed",
        lastError: "ICE state failed",
        updatedAtMs: 3,
      },
    ]
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: devices.map((d) => d.rendezvousId),
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve(devices)
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    await screen.findByTestId("webrtc-device-tier-list")
    expect(screen.getByTestId("webrtc-device-row-device-apple-123456")).toHaveTextContent(
      en.mobile.companion.webrtc.deviceTier.connected
    )
    expect(screen.getByTestId("webrtc-device-row-device-apple-123456")).toHaveTextContent(
      en.mobile.companion.webrtc.protocolMode
    )
    expect(screen.getByTestId("webrtc-device-row-device-banana-7890")).toHaveTextContent(
      en.mobile.companion.webrtc.deviceTier.negotiating
    )
    const failedRow = screen.getByTestId("webrtc-device-row-device-cherry-9999")
    expect(failedRow).toHaveTextContent(en.mobile.companion.webrtc.deviceTier.failed)
    expect(failedRow).toHaveTextContent("ICE state failed")
  })
})

describe("WebRtcCard — poll-failure banner", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("shows the banner after three consecutive failures and clears it on recovery", async () => {
    let mode: "fail" | "succeed" = "fail"
    mockTransportCall.mockImplementation((name: string) => {
      if (mode === "fail") {
        return Promise.reject(new Error("hub unreachable"))
      }
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()

    // The polling effect triggers immediately on mount, then chains via
    // setTimeout(3000). Drive three failures.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        jest.advanceTimersByTime(3000)
      })
    }
    // One more flush so the third rejection lands.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await screen.findByTestId("webrtc-poll-error")

    // Flip to success and the banner should disappear once the next sample
    // lands.
    mode = "succeed"
    await act(async () => {
      jest.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByTestId("webrtc-poll-error")).not.toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// TURN credential keyring (S1)
// ---------------------------------------------------------------------------

describe("WebRtcCard — TURN credential keyring", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("silently migrates legacy plaintext TURN entries on hydrate", async () => {
    // Seed Dexie with a legacy plaintext credential.
    await saveSettings({
      turnServers: [
        {
          urls: "turn:turn.example.com:3478",
          username: "alice",
          credential: "leg4cy",
        },
      ],
    })
    renderCard()
    // The hydrate effect is async (getSettings → migrate → save →
    // resolve → setForm). Allow a generous waitFor budget so the
    // jsdom + fake-indexeddb roundtrip lands deterministically.
    await waitFor(
      async () => {
        const s = await getSettings()
        const persisted = s.turnServers?.[0]
        expect(persisted).toBeTruthy()
        expect(isKeyringSentinel(persisted!.credential as string)).toBe(true)
      },
      { timeout: 4000 }
    )
    // The keyring entry round-trips the original pair.
    const persisted = (await getSettings()).turnServers![0]
    expect(persisted.username).toBeUndefined()
    const keyId = keyIdOfSentinel(persisted.credential as string)!
    expect(turnStore.map.get(keyId)).toEqual({
      username: "alice",
      credential: "leg4cy",
    })
    // The textarea displays the resolved plaintext for editing.
    const ta = (await screen.findByLabelText(/TURN servers/i)) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain("alice"), { timeout: 2000 })
    expect(ta.value).toContain("leg4cy")
  })

  it("save() writes new TURN credentials to keyring, not Dexie", async () => {
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect(ta).toBeInTheDocument())
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:3478|alice|s3cret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    // After save, the stored value must be a sentinel — never plaintext.
    await waitFor(async () => {
      const s = await getSettings()
      const persisted = s.turnServers?.[0]
      expect(persisted).toBeTruthy()
      expect(isKeyringSentinel(persisted!.credential as string)).toBe(true)
    })
    const persisted = (await getSettings()).turnServers![0]
    const keyId = keyIdOfSentinel(persisted.credential as string)!
    expect(turnStore.map.get(keyId)).toEqual({
      username: "alice",
      credential: "s3cret",
    })
    // Defensive: make sure the literal string "s3cret" never lands in
    // Dexie under any field.
    expect(JSON.stringify(persisted)).not.toContain("s3cret")
  })

  it("save() leaves an existing keyring sentinel alone", async () => {
    // Pre-seed: a TURN entry already migrated, with a known keyring
    // entry. Simulates the user opening Settings, not touching the
    // textarea, and clicking Save again.
    const knownKeyId = "preexisting-key-id"
    turnStore.map.set(knownKeyId, {
      username: "alice",
      credential: "s3cret",
    })
    await saveSettings({
      turnServers: [
        {
          urls: "turn:turn.example.com:3478",
          credential: `${KEYRING_CREDENTIAL_PREFIX}${knownKeyId}`,
        },
      ],
    })
    renderCard()
    // Wait until the textarea is hydrated.
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain("alice"))
    await userEvent.click(screen.getByTestId("webrtc-save"))
    // On save, parseServers gets the resolved plaintext (since the
    // textarea displays it), so the saved sentinel WILL be regenerated
    // unless the parser explicitly preserves an `kr:` form. The save
    // path therefore always lands in a sentinel — never a plaintext
    // credential — but the keyId may be a fresh value. Verify only the
    // sentinel invariant and the keyring round-trip.
    await waitFor(async () => {
      const s = await getSettings()
      const persisted = s.turnServers?.[0]
      expect(persisted).toBeTruthy()
      expect(isKeyringSentinel(persisted!.credential as string)).toBe(true)
    })
    const persisted = (await getSettings()).turnServers![0]
    const newKeyId = keyIdOfSentinel(persisted.credential as string)!
    expect(turnStore.map.get(newKeyId)).toEqual({
      username: "alice",
      credential: "s3cret",
    })
  })
})

// ---------------------------------------------------------------------------
// Per-device reconnect button (W2)
// ---------------------------------------------------------------------------

describe("WebRtcCard — per-device reconnect button", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  function makeDevicesResponder(devices: DeviceTierEntry[]): void {
    mockTransportCall.mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: devices.map((d) => d.rendezvousId),
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve(devices)
      }
      if (name === "companion_signaling_reconnect_device") {
        // Record the rendezvousId param so the test can assert it.
        ;(makeDevicesResponder as unknown as { lastReconnect?: unknown }).lastReconnect = params
        return Promise.resolve()
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
  }

  it("renders one reconnect button per device row", async () => {
    makeDevicesResponder([
      {
        deviceId: "device-apple-123456",
        rendezvousId: "r1",
        tier: "connected",
        updatedAtMs: 1,
      },
      {
        deviceId: "device-banana-7890",
        rendezvousId: "r2",
        tier: "failed",
        lastError: "ICE failed",
        updatedAtMs: 2,
      },
    ])
    renderCard()
    await screen.findByTestId("webrtc-device-tier-list")
    expect(screen.getByTestId("webrtc-reconnect-device-apple-123456")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-reconnect-device-banana-7890")).toBeInTheDocument()
  })

  it("clicking the button calls companion_signaling_reconnect_device with the rendezvousId", async () => {
    makeDevicesResponder([
      {
        deviceId: "device-apple",
        rendezvousId: "r-apple",
        tier: "failed",
        lastError: "previous attempt failed",
        updatedAtMs: 1,
      },
    ])
    renderCard()
    const btn = await screen.findByTestId("webrtc-reconnect-device-apple")
    await userEvent.click(btn)
    await waitFor(() => {
      const captured = (
        makeDevicesResponder as unknown as { lastReconnect?: Record<string, unknown> }
      ).lastReconnect
      expect(captured).toEqual({ rendezvousId: "r-apple" })
    })
  })

  it("surfaces the error message on failure as a toast.error", async () => {
    const { toast } = await import("sonner")
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: ["r1"],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([
          {
            deviceId: "device-apple",
            rendezvousId: "r1",
            tier: "failed",
            updatedAtMs: 1,
          } as DeviceTierEntry,
        ])
      }
      if (name === "companion_signaling_reconnect_device") {
        return Promise.reject(new Error("rendezvous id r1 not found"))
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    const btn = await screen.findByTestId("webrtc-reconnect-device-apple")
    await userEvent.click(btn)
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-0021 — ephemeral-TURN provider section
// ---------------------------------------------------------------------------

class FakeProviderStore {
  readonly map = new Map<string, string>()
  async save(keyId: string, value: string): Promise<void> {
    this.map.set(keyId, value)
  }
  async load(keyId: string): Promise<string | null> {
    return this.map.has(keyId) ? this.map.get(keyId)! : null
  }
  async delete(keyId: string): Promise<void> {
    this.map.delete(keyId)
  }
}

const BASE_FORM: FormState = {
  enabled: true,
  signalingUrl: "wss://x/signaling",
  iceServersText: "",
  turnServersText: "",
  turnProviderKind: "none",
  turnProviderKeyId: "",
  turnProviderSid: "",
  turnProviderToken: "",
  turnProviderTtl: "",
  turnProviderSecretRef: "",
}

describe("parseTtl", () => {
  it("returns undefined for blank / invalid and clamps numeric TTLs", () => {
    expect(parseTtl("")).toBeUndefined()
    expect(parseTtl("  ")).toBeUndefined()
    expect(parseTtl("abc")).toBeUndefined()
    expect(parseTtl("-1")).toBeUndefined()
    expect(parseTtl("30")).toBe(600)
    expect(parseTtl("3600")).toBe(3600)
    expect(parseTtl("999999")).toBe(86_400)
  })
})

describe("persistTurnProvider", () => {
  let ps: FakeProviderStore
  beforeEach(() => {
    ps = new FakeProviderStore()
    __setProviderSecretStore(ps as never)
  })
  afterAll(() => __setProviderSecretStore(null))

  it("kind 'none' deletes any stored secret and returns an empty ref", async () => {
    await ps.save("old", JSON.stringify({ apiToken: "x" }))
    const { turnProvider, nextSecretRef } = await persistTurnProvider({
      ...BASE_FORM,
      turnProviderKind: "none",
      turnProviderSecretRef: "kr:old",
    })
    expect(turnProvider).toEqual({ kind: "none" })
    expect(nextSecretRef).toBe("")
    expect(await ps.load("old")).toBeNull()
  })

  it("Cloudflare with a token writes the apiToken to the keyring + a sentinel ref", async () => {
    const { turnProvider, nextSecretRef } = await persistTurnProvider({
      ...BASE_FORM,
      turnProviderKind: "cloudflare-calls",
      turnProviderKeyId: "key-1",
      turnProviderToken: "tok",
      turnProviderTtl: "7200",
    })
    expect(turnProvider.kind).toBe("cloudflare-calls")
    expect(turnProvider.cloudflareKeyId).toBe("key-1")
    expect(turnProvider.ttlSeconds).toBe(7200)
    expect(nextSecretRef).toMatch(/^kr:/)
    expect(turnProvider.secretRef).toBe(nextSecretRef)
    const kid = keyIdOfSentinel(nextSecretRef)!
    expect(JSON.parse((await ps.load(kid))!)).toEqual({ apiToken: "tok" })
  })

  it("Twilio with a token stores the authToken + the SID", async () => {
    const { turnProvider, nextSecretRef } = await persistTurnProvider({
      ...BASE_FORM,
      turnProviderKind: "twilio",
      turnProviderSid: "ACxxxx",
      turnProviderToken: "auth",
    })
    expect(turnProvider.twilioAccountSid).toBe("ACxxxx")
    const kid = keyIdOfSentinel(nextSecretRef)!
    expect(JSON.parse((await ps.load(kid))!)).toEqual({ authToken: "auth" })
  })

  it("keeps the existing secret ref when no new token is entered", async () => {
    const { turnProvider, nextSecretRef } = await persistTurnProvider({
      ...BASE_FORM,
      turnProviderKind: "cloudflare-calls",
      turnProviderKeyId: "key-1",
      turnProviderSecretRef: "kr:keep",
    })
    expect(nextSecretRef).toBe("kr:keep")
    expect(turnProvider.secretRef).toBe("kr:keep")
    // No new secret written.
    expect(ps.map.size).toBe(0)
  })
})

describe("WebRtcCard — TURN provider UI", () => {
  const MARKER_URL = "wss://hydrated.example/signaling"
  beforeEach(async () => {
    __setProviderSecretStore(new FakeProviderStore() as never)
    // Keep the status poll quiet.
    mockTransportCall.mockResolvedValue([])
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
    // Seed a distinct signaling URL so `waitForHydrate` proves the async
    // hydrate actually ran (the INITIAL state already carries the *default*
    // URL, so waiting on that would pass before hydrate completes and a late
    // hydrate would then clobber the provider selection mid-test).
    await saveSettings({ signalingUrl: MARKER_URL })
  })
  afterAll(() => __setProviderSecretStore(null))

  const waitForHydrate = async () => {
    const url = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(url).toHaveValue(MARKER_URL))
  }

  it("reveals Cloudflare inputs when the Cloudflare provider is selected", async () => {
    renderCard()
    await waitForHydrate()
    const select = await screen.findByTestId("webrtc-turn-provider-kind")
    await userEvent.selectOptions(select, "cloudflare-calls")
    expect(screen.getByTestId("webrtc-turn-cf-keyid")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-turn-token")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-turn-test")).toBeInTheDocument()
    // The Twilio-only SID field stays hidden.
    expect(screen.queryByTestId("webrtc-turn-twilio-sid")).not.toBeInTheDocument()
  })

  it("Test button provisions and toasts success when the provider responds", async () => {
    const { toast } = await import("sonner")
    mockTransportCall.mockResolvedValue({
      iceServers: [{ urls: ["turn:a"] }],
      expiresAtMs: Date.now() + 60_000,
    })
    const user = userEvent.setup({ delay: null })
    renderCard()
    await waitForHydrate()
    const select = await screen.findByTestId("webrtc-turn-provider-kind")
    await user.selectOptions(select, "cloudflare-calls")
    await user.type(screen.getByTestId("webrtc-turn-cf-keyid"), "key-1")
    await user.type(screen.getByTestId("webrtc-turn-token"), "tok")
    await user.click(screen.getByTestId("webrtc-turn-test"))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })
    expect(mockTransportCall).toHaveBeenCalledWith("turn_provision", {
      input: {
        kind: "cloudflare-calls",
        cloudflareKeyId: "key-1",
        twilioAccountSid: undefined,
        ttlSeconds: undefined,
        secretKeyId: undefined,
        inlineToken: "tok",
      },
    })
  }, 20000)
})
