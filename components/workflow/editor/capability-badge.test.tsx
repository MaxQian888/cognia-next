/**
 * @jest-environment jsdom
 */
import { render, screen, renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import enMessages from "@/i18n/messages/en.json"
import { CapabilityBadge, useMissingNodeCapabilities } from "./capability-badge"

const TAURI_KEY = "__TAURI_INTERNALS__"

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
})

describe("CapabilityBadge", () => {
  it("renders the badge label with the tooltip as title", () => {
    render(
      <CapabilityBadge
        info={{ missing: ["camera"], badgeLabel: "Unavailable here", tooltip: "Needs: Camera" }}
      />,
      { wrapper }
    )
    const badge = screen.getByTestId("wf-capability-badge")
    expect(badge).toHaveTextContent("Unavailable here")
    expect(badge).toHaveAttribute("title", "Needs: Camera")
  })
})
