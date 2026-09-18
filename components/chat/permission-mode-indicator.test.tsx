/**
 * @jest-environment jsdom
 */

import type { ReactElement } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PermissionModeIndicator, nextPermissionMode } from "./permission-mode-indicator"
import type { PermissionMode } from "@/stores/chat"

// The app mounts TooltipProvider in the root layout; provide it here so the
// chip's tooltip has its Radix context.
function renderChip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let currentMode: PermissionMode | null = null
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { permissionMode: PermissionMode | null }) => unknown) =>
    sel({ permissionMode: currentMode }),
}))

describe("nextPermissionMode (safe cycle)", () => {
  it("cycles the safe core and never lands on bypassPermissions", () => {
    expect(nextPermissionMode(null)).toBe("acceptEdits")
    expect(nextPermissionMode("acceptEdits")).toBe("plan")
    expect(nextPermissionMode("plan")).toBeNull()
    // A power mode de-escalates back to default (null), never escalates.
    expect(nextPermissionMode("bypassPermissions")).toBeNull()
  })
})

describe("PermissionModeIndicator", () => {
  it("shows the current mode label and cycles on click", async () => {
    currentMode = null
    const onCycle = jest.fn()
    renderChip(<PermissionModeIndicator onCycle={onCycle} />)
    // null → default label; clicking advances to acceptEdits.
    expect(screen.getByRole("button")).toHaveTextContent("default.label")
    await userEvent.click(screen.getByRole("button"))
    expect(onCycle).toHaveBeenCalledWith("acceptEdits")
  })

  it("leads with a risk-keyed glyph instead of a text marker", () => {
    currentMode = "bypassPermissions"
    const { rerender } = renderChip(<PermissionModeIndicator onCycle={jest.fn()} />)
    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("data-risk", "danger")
    expect(button.querySelector("svg.lucide-shield-alert")).not.toBeNull()
    expect(button).toHaveTextContent(/^bypass\.label$/)

    currentMode = null
    rerender(
      <TooltipProvider>
        <PermissionModeIndicator onCycle={jest.fn()} />
      </TooltipProvider>
    )
    expect(screen.getByRole("button")).toHaveAttribute("data-risk", "safe")
    expect(screen.getByRole("button").querySelector("svg.lucide-shield-check")).not.toBeNull()
  })

  // Fold tier 2 keeps the risk glyph and gives up the word — the label's
  // meaning is already carried by the icon's shape+colour and the tooltip.
  it("keeps the risk glyph and drops the word in glyph form", () => {
    currentMode = "bypassPermissions"
    renderChip(<PermissionModeIndicator onCycle={jest.fn()} glyph />)
    const button = screen.getByRole("button")
    expect(button).not.toHaveTextContent("bypass.label")
    expect(button.querySelector("svg.lucide-shield-alert")).not.toBeNull()
    expect(button.className).toContain("w-7")
    expect(button).toHaveAttribute("data-risk", "danger")
  })

  it("can be disabled", () => {
    currentMode = "plan"
    renderChip(<PermissionModeIndicator onCycle={jest.fn()} disabled />)
    expect(screen.getByRole("button")).toBeDisabled()
  })
})
