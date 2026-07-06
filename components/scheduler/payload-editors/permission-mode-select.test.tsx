/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PermissionModeSelect } from "./permission-mode-select"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/ai/agent/external/permission-modes", () => ({
  supportedPermissionModes: () => ["default", "plan", "bypassPermissions"],
}))

describe("PermissionModeSelect", () => {
  it("renders the placeholder as the trigger value when unset", () => {
    render(<PermissionModeSelect value={undefined} onChange={jest.fn()} testId="perm" />)
    // Radix collapses the option list until opened; the trigger shows the
    // placeholder label for the empty selection.
    expect(screen.getByTestId("perm")).toHaveTextContent("permissionModeUseDefault")
  })

  it("reflects the selected mode label on the trigger", () => {
    render(<PermissionModeSelect value="plan" onChange={jest.fn()} testId="perm" />)
    expect(screen.getByTestId("perm")).toHaveTextContent("permissionModes.plan")
  })
})
