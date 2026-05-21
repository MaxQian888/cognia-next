/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/ocr/ocr-section-persisted", () => ({
  OcrSectionPersisted: () => <div data-testid="stub-ocr" />,
}))

import Page from "./page"

describe("MobileOcrPage", () => {
  it("renders the OCR section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-ocr-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-ocr")).toBeInTheDocument()
  })
})
