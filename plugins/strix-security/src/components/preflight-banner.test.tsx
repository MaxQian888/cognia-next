/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { PreflightBanner } from "./preflight-banner"

describe("PreflightBanner", () => {
  it("shows the checking state", () => {
    render(<PreflightBanner status={null} checking onRecheck={() => {}} />)
    expect(screen.getByTestId("strix-preflight-checking")).toBeInTheDocument()
  })

  it("shows the ready state with the strix version", () => {
    render(
      <PreflightBanner
        status={{ docker: true, strix: true, strixVersion: "0.1.3", checkedAt: 0 }}
        checking={false}
        onRecheck={() => {}}
      />
    )
    expect(screen.getByTestId("strix-preflight-ok")).toBeInTheDocument()
    expect(screen.getByText(/0\.1\.3/)).toBeInTheDocument()
  })

  it("shows the blocked state and fires re-check", () => {
    const onRecheck = jest.fn()
    render(
      <PreflightBanner
        status={{ docker: false, strix: false, checkedAt: 0 }}
        checking={false}
        onRecheck={onRecheck}
      />
    )
    expect(screen.getByTestId("strix-preflight-blocked")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("strix-preflight-retry"))
    expect(onRecheck).toHaveBeenCalledTimes(1)
  })
})
