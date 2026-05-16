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

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

import {
  WebRtcCard,
  parseServers,
  stringifyServers,
  TierDot,
  type DeviceTierEntry,
} from "./webrtc-card"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

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

beforeEach(() => {
  jest.clearAllMocks()
  mockTransportCall.mockImplementation(() =>
    Promise.reject(new Error("not configured for this test"))
  )
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
    await waitFor(() => expect(input).toHaveValue("wss://signaling.cognia.app/v1/signaling"))
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
          signalingUrl: "wss://signaling.cognia.app/v1/signaling",
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
          signalingUrl: "wss://signaling.cognia.app/v1/signaling",
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
          signalingUrl: "wss://signaling.cognia.app/v1/signaling",
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
          signalingUrl: "wss://signaling.cognia.app/v1/signaling",
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
