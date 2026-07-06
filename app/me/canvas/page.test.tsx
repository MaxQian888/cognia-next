/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/canvas-section", () => ({
  CanvasSection: () => <div data-testid="stub-canvas" />,
}))

import Page from "./page"

describe("MobileCanvasPage", () => {
  it("renders the Canvas section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-canvas-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-canvas")).toBeInTheDocument()
  })
})
