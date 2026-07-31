/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { ScanForm } from "./scan-form"

function setup(props: Partial<Parameters<typeof ScanForm>[0]> = {}) {
  const onStart = jest.fn()
  const onCancel = jest.fn()
  render(<ScanForm scanning={false} canScan onStart={onStart} onCancel={onCancel} {...props} />)
  return { onStart, onCancel }
}

describe("ScanForm", () => {
  it("keeps Start disabled until target + authorization are given, then submits", () => {
    const { onStart } = setup()
    const start = screen.getByTestId("strix-start")
    expect(start).toBeDisabled()

    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "https://x" } })
    expect(start).toBeDisabled() // not yet authorized

    fireEvent.click(screen.getByTestId("strix-authorized"))
    expect(start).toBeEnabled()

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ target: "https://x" }))
  })

  it("keeps Start disabled when preflight has not passed", () => {
    setup({ canScan: false })
    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("strix-authorized"))
    expect(screen.getByTestId("strix-start")).toBeDisabled()
  })

  it("shows Cancel while scanning and fires it", () => {
    const { onCancel } = setup({ scanning: true })
    expect(screen.queryByTestId("strix-start")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("strix-cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
