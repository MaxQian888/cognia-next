/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/connections/connections-section", () => ({
  ConnectionsSection: () => <div data-testid="stub-connections" />,
}))

import Page from "./page"

describe("MobileConnectorsPage", () => {
  it("renders the connections section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-connectors-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-connections")).toBeInTheDocument()
  })
})
