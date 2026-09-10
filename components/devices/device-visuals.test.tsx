let mockNow = new Date("2026-09-09T08:00:00Z")
const mockRelativeTime = jest.fn(() => "a minute ago")
const mockUseNow = jest.fn((_options?: unknown) => mockNow)
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (
      ({
        "reachability.recently-active": "Recently active",
        "adminState.revoked": "Revoked",
        "grantState.partial": "Partial",
      }) as Record<string, string>
    )[key] ?? key,
  useNow: (options: unknown) => mockUseNow(options),
  useFormatter: () => ({ relativeTime: mockRelativeTime }),
}))

import { render, renderHook, screen } from "@testing-library/react"

import {
  AdminStateBadge,
  CapabilityDot,
  DeviceKindIcon,
  GrantStateBadge,
  ReachabilityDot,
  ReachabilityLabel,
  capabilityToneClass,
  shortenFingerprint,
  useDeviceRelativeTime,
} from "./device-visuals"

describe("ReachabilityDot / ReachabilityLabel", () => {
  it("gives online and recently-active different colours", () => {
    const { container: online } = render(<ReachabilityDot reachability="online" />)
    const { container: recent } = render(<ReachabilityDot reachability="recently-active" />)
    expect(online.firstElementChild?.className).toContain("bg-emerald-500")
    expect(recent.firstElementChild?.className).toContain("bg-amber-500")
  })

  /**
   * "We have never heard from it" is the absence of a signal, not a fifth
   * severity — so it must not borrow the alarming colour.
   */
  it("keeps never-seen muted rather than alarming", () => {
    const { container } = render(<ReachabilityDot reachability="unknown" />)
    expect(container.firstElementChild?.className).toContain("bg-muted-foreground")
  })

  it("labels each state with translated text", () => {
    render(<ReachabilityLabel reachability="recently-active" />)
    expect(screen.getByText("Recently active")).toBeInTheDocument()
  })
})

describe("AdminStateBadge", () => {
  it("renders nothing for an active device, so the rail stays quiet", () => {
    const { container } = render(<AdminStateBadge state="active" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders paused and revoked", () => {
    render(<AdminStateBadge state="revoked" />)
    expect(screen.getByText("Revoked")).toBeInTheDocument()
  })
})

describe("capability tones", () => {
  /**
   * `expected` and `unknown` both mean "nobody confirmed this"; `absent` is a
   * real answer from a device that did report. Collapsing them would make an
   * unreported device look like a device that lacks everything.
   */
  it("separates an unconfirmed capability from an answered miss", () => {
    expect(capabilityToneClass("absent")).toContain("muted")
    expect(capabilityToneClass("expected")).toContain("amber")
    expect(capabilityToneClass("unknown")).toContain("amber")
    expect(capabilityToneClass("reported")).toContain("emerald")
  })

  it("renders a dot for each state", () => {
    const { container } = render(<CapabilityDot state="reported" />)
    expect(container.firstElementChild?.className).toContain("bg-emerald-500")
  })
})

describe("GrantStateBadge", () => {
  /** Partial is the state this console exists to expose. */
  it("does not let a partial grant share a colour with a denied one", () => {
    const { container: partial } = render(<GrantStateBadge state="partial" />)
    const { container: denied } = render(<GrantStateBadge state="denied" />)
    expect(screen.getByText("Partial")).toBeInTheDocument()
    expect(partial.firstElementChild?.className).not.toEqual(denied.firstElementChild?.className)
  })
})

describe("DeviceKindIcon", () => {
  it("renders a distinct icon per kind", () => {
    const kinds = ["local", "paired-device", "remote-host", "worker"] as const
    const classes = kinds.map((kind) => {
      const { container } = render(<DeviceKindIcon kind={kind} />)
      return container.querySelector("svg")?.getAttribute("class") ?? ""
    })
    expect(classes.every((value) => value.length > 0)).toBe(true)
  })
})

describe("shortenFingerprint", () => {
  /**
   * The old card truncated to the first 12 characters — exactly the part two
   * fingerprints are most likely to be compared on and least likely to differ
   * in a screenshot.
   */
  it("keeps both ends so two fingerprints stay distinguishable", () => {
    const a = `${"a".repeat(56)}11111111`
    const b = `${"a".repeat(56)}22222222`
    expect(shortenFingerprint(a)).not.toEqual(shortenFingerprint(b))
    expect(shortenFingerprint(a)).toBe("aaaaaaaaaaaa…11111111")
  })

  it("leaves short values alone and answers null for nothing", () => {
    expect(shortenFingerprint("abc")).toBe("abc")
    expect(shortenFingerprint(undefined)).toBeNull()
  })
})

it("formats device timestamps against an explicit shared clock", () => {
  const { result } = renderHook(() => useDeviceRelativeTime())
  const timestamp = mockNow.getTime() - 60_000
  result.current(timestamp)
  expect(mockRelativeTime).toHaveBeenCalledWith(new Date(timestamp), {
    now: mockNow,
    unit: "minute",
  })
  for (const invalid of [undefined, 0, -1, NaN, Infinity]) {
    expect(result.current(invalid)).toBe("never")
  }
})

describe("quiet device timestamps", () => {
  beforeEach(() => {
    mockNow = new Date("2026-09-09T08:00:00Z")
    jest.clearAllMocks()
  })

  it("uses a minute display clock instead of ticking every second", () => {
    renderHook(() => useDeviceRelativeTime())
    expect(mockUseNow).toHaveBeenCalledWith({ updateInterval: 60_000 })
  })

  it("keeps recent reports stable across polling and small clock differences", () => {
    const { result, rerender } = renderHook(() => useDeviceRelativeTime())
    const start = mockNow.getTime()
    for (const age of [0, 1_000, 4_000, 59_999, -5_000]) {
      expect(result.current(start - age)).toBe("justNow")
    }
    mockNow = new Date(start + 5_000)
    rerender()
    expect(result.current(start + 5_000)).toBe("justNow")
    expect(mockRelativeTime).not.toHaveBeenCalled()
  })

  it("moves a stale report from just now to minutes, then hours", () => {
    const timestamp = mockNow.getTime()
    const { result, rerender } = renderHook(() => useDeviceRelativeTime())
    expect(result.current(timestamp)).toBe("justNow")
    mockNow = new Date(timestamp + 60_000)
    rerender()
    result.current(timestamp)
    expect(mockRelativeTime).toHaveBeenLastCalledWith(new Date(timestamp), {
      now: mockNow,
      unit: "minute",
    })
    mockNow = new Date(timestamp + 3_600_000)
    rerender()
    result.current(timestamp)
    expect(mockRelativeTime).toHaveBeenLastCalledWith(new Date(timestamp), mockNow)
  })
})
