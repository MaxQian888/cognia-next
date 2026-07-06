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

  it("prefixes a danger marker for bypassPermissions", () => {
    currentMode = "bypassPermissions"
    renderChip(<PermissionModeIndicator onCycle={jest.fn()} />)
    expect(screen.getByRole("button")).toHaveTextContent("⚠")
    expect(screen.getByRole("button")).toHaveTextContent("bypass.label")
  })

  it("can be disabled", () => {
    currentMode = "plan"
    renderChip(<PermissionModeIndicator onCycle={jest.fn()} disabled />)
    expect(screen.getByRole("button")).toBeDisabled()
  })
})
