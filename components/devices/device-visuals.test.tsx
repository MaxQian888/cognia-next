import { render, screen } from "@testing-library/react"

import {
  AdminStateBadge,
  CapabilityDot,
  DeviceKindIcon,
  GrantStateBadge,
  ReachabilityDot,
  ReachabilityLabel,
  capabilityToneClass,
  shortenFingerprint,
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
