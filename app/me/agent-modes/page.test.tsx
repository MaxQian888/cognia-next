/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/agent/custom-mode-settings", () => ({
  CustomModeSettings: () => <div data-testid="stub-agent-modes" />,
}))

import Page from "./page"

describe("MobileAgentModesPage", () => {
  it("renders the custom agent modes section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-agent-modes-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-agent-modes")).toBeInTheDocument()
  })
})
