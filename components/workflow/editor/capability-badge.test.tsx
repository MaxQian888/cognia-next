/**
 * @jest-environment jsdom
 */
import { render, screen, renderHook, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import enMessages from "@/i18n/messages/en.json"

// Deterministic paired-device rows: mock the liveQuery layer itself so the
// hook sees a synchronous snapshot (dexie-react-hooks needs a real Dexie
// observable otherwise).
let mockDevices: unknown[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockDevices,
}))
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: async () => mockDevices,
}))

import { CapabilityBadge, useMissingNodeCapabilities } from "./capability-badge"

const TAURI_KEY = "__TAURI_INTERNALS__"

beforeEach(() => {
  mockDevices = []
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages as never}>
      {children}
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
})

describe("useMissingNodeCapabilities", () => {
  it("returns null when the entry has no requirements", () => {
    const { result } = renderHook(() => useMissingNodeCapabilities({}), { wrapper })
    expect(result.current).toBeNull()
  })

  it("reports missing capabilities with localized names on web", () => {
    // jsdom (no Tauri marker) → web baseline → no shell/pty.
    const { result } = renderHook(
      () => useMissingNodeCapabilities({ requires: ["shell", "pty"] }),
      { wrapper }
    )
    expect(result.current?.missing).toEqual(["shell", "pty"])
    expect(result.current?.badgeLabel).toBe("Unavailable here")
    expect(result.current?.tooltip).toContain("Shell")
    expect(result.current?.tooltip).toContain("Integrated terminal")
  })

  it("returns null when the local baseline satisfies the entry (tauri)", () => {
    ;(window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
    const { result } = renderHook(() => useMissingNodeCapabilities({ requires: ["shell"] }), {
      wrapper,
    })
    expect(result.current).toBeNull()
  })

  it("maps legacy desktopOnly to the shell requirement", () => {
    const { result } = renderHook(() => useMissingNodeCapabilities({ desktopOnly: true }), {
      wrapper,
    })
    expect(result.current?.missing).toEqual(["shell"])
  })

  it("surfaces plugin-scoped capability ids verbatim", () => {
    const { result } = renderHook(() => useMissingNodeCapabilities({ requires: ["plugin:demo"] }), {
      wrapper,
    })
    expect(result.current?.tooltip).toContain("plugin:demo")
  })

  it("flags requirements covered by an active paired device as remote (ADR 0061 P3)", () => {
    mockDevices = [
      { deviceId: "dev-1", lastSeenAt: 1, capabilities: ["camera"] },
      { deviceId: "dev-revoked", lastSeenAt: 2, revokedAt: 3, capabilities: ["pty"] },
    ]
    const { result } = renderHook(() => useMissingNodeCapabilities({ requires: ["camera"] }), {
      wrapper,
    })
    expect(result.current?.satisfiedRemotely).toBe(true)
    expect(result.current?.badgeLabel).toBe("Runs on phone")

    // A revoked device's manifest does not count.
    const { result: revoked } = renderHook(
      () => useMissingNodeCapabilities({ requires: ["pty"] }),
      {
        wrapper,
      }
    )
    expect(revoked.current?.satisfiedRemotely).toBe(false)
  })
})

describe("CapabilityBadge", () => {
  it("renders the badge label with the tooltip as title", () => {
    render(
      <CapabilityBadge
        info={{
          missing: ["camera"],
          badgeLabel: "Unavailable here",
          tooltip: "Needs: Camera",
          satisfiedRemotely: false,
        }}
      />,
      { wrapper }
    )
    const badge = screen.getByTestId("wf-capability-badge")
    expect(badge).toHaveTextContent("Unavailable here")
    expect(badge).toHaveAttribute("title", "Needs: Camera")
    expect(badge).not.toHaveAttribute("data-remote")
  })

  it("styles remotely-satisfied requirements as informational", () => {
    render(
      <CapabilityBadge
        info={{
          missing: ["camera"],
          badgeLabel: "Runs on phone",
          tooltip: "Runs on a paired device that provides: Camera",
          satisfiedRemotely: true,
        }}
      />,
      { wrapper }
    )
    expect(screen.getByTestId("wf-capability-badge")).toHaveAttribute("data-remote", "true")
  })
})
