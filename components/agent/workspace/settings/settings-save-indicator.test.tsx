/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  SettingsSaveIndicator,
  markSettingsSaved,
  __resetSettingsSaveTrackerForTesting,
} from "./settings-save-indicator"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const refreshMock = jest.fn()
jest.mock("@/lib/ai/agent/team/capability-audit", () => ({
  refreshAllInstanceCapabilityWarnings: (...args: unknown[]) => refreshMock(...args),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

describe("SettingsSaveIndicator", () => {
  beforeEach(() => {
    __resetSettingsSaveTrackerForTesting()
    refreshMock.mockReset()
    refreshMock.mockResolvedValue({ warningsByTeamId: {}, totalWarnings: 0 })
  })

  it("shows the unsaved badge before any save", () => {
    render(<SettingsSaveIndicator teamId="team-1" />)
    expect(screen.getByTestId("settings-save-indicator")).toHaveTextContent("unsaved")
  })

  it("flips to the saved badge after markSettingsSaved()", () => {
    render(<SettingsSaveIndicator teamId="team-1" />)
    act(() => {
      markSettingsSaved()
    })
    expect(screen.getByTestId("settings-save-indicator")).toHaveTextContent("savedJustNow")
  })

  it("runs the capability audit when 'Audit now' is clicked", async () => {
    render(<SettingsSaveIndicator teamId="team-1" />)
    fireEvent.click(screen.getByRole("button", { name: /auditNow/ }))
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  })
})
