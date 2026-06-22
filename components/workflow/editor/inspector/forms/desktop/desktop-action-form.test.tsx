/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { DesktopActionForm } from "./desktop-action-form"
import {
  DesktopClickConfig,
  DesktopInvokePatternConfig,
  DesktopKeysConfig,
  DesktopScreenshotConfig,
  DesktopTypeConfig,
  DesktopWindowResizeConfig,
} from "./index"

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ workflows: { validation: {} } }} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("DesktopActionForm shared", () => {
  it("renders selector + timeoutMs + retries", () => {
    wrap(<DesktopActionForm params={{}} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/Selector/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Timeout/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Retries/i)).toBeInTheDocument()
  })

  it("hides selector when showSelector=false", () => {
    wrap(<DesktopActionForm params={{}} onChange={jest.fn()} showSelector={false} />)
    expect(screen.queryByLabelText(/Selector/i)).not.toBeInTheDocument()
  })

  it("propagates changes through onChange with patched params", () => {
    const onChange = jest.fn()
    wrap(<DesktopActionForm params={{ existing: 1 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Timeout/i), { target: { value: "1234" } })
    const last = onChange.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(last).toMatchObject({ existing: 1, timeoutMs: 1234 })
  })
})

describe("Per-kind thin shells", () => {
  it("DesktopScreenshotConfig surfaces format + outputPath", () => {
    wrap(<DesktopScreenshotConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/Format/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Output path/i)).toBeInTheDocument()
  })

  it("DesktopClickConfig surfaces button + click count", () => {
    wrap(<DesktopClickConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/Button/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Click count/i)).toBeInTheDocument()
  })

  it("DesktopTypeConfig surfaces text + per-key delay", () => {
    wrap(<DesktopTypeConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/^Text/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Per-key delay/i)).toBeInTheDocument()
  })

  it("DesktopKeysConfig hides the selector and surfaces the chord field", () => {
    wrap(<DesktopKeysConfig params={{}} onChange={jest.fn()} />)
    expect(screen.queryByLabelText(/Selector/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Key chord/i)).toBeInTheDocument()
  })

  it("DesktopWindowResizeConfig surfaces width + height", () => {
    wrap(<DesktopWindowResizeConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/Width/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Height/i)).toBeInTheDocument()
  })

  it("DesktopInvokePatternConfig emits automation PatternKind values", () => {
    const onChange = jest.fn()
    wrap(<DesktopInvokePatternConfig params={{}} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole("combobox", { name: /Pattern/i }), { key: "ArrowDown" })
    fireEvent.click(screen.getByText(/Toggle/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pattern: "toggle" }))
  })
})
