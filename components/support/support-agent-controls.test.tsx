/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { fireEvent, render, screen } from "@testing-library/react"
import { SupportAgentControls } from "./support-agent-controls"
import { SUPPORT_DIAGNOSTICS_STORAGE_KEY } from "@/lib/support-agent/context"

beforeEach(() => localStorage.clear())

it("exposes and persists the local diagnostics kill switch", () => {
  render(<SupportAgentControls />)
  const toggle = screen.getByRole("switch", { name: "diagnostics" })
  expect(toggle).toBeChecked()

  fireEvent.click(toggle)

  expect(toggle).not.toBeChecked()
  expect(localStorage.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY)).toBe("false")
})
