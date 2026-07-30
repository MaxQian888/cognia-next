/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/eval/eval-settings-section", () => ({
  EvalSettingsSection: () => <div data-testid="stub-eval" />,
}))

import Page from "./page"

describe("MobileEvalPage", () => {
  it("renders the Eval settings section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-eval-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-eval")).toBeInTheDocument()
  })

  it("titles the page from the mobile.me namespace", () => {
    render(<Page />)
    expect(screen.getByText("evalRow")).toBeInTheDocument()
  })
})
