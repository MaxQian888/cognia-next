/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { MobileGhostAccept } from "./mobile-ghost-accept"

jest.mock("@/lib/capacitor/haptics", () => ({
  __esModule: true,
  impact: jest.fn(),
}))

import { impact } from "@/lib/capacitor/haptics"

const mockImpact = impact as jest.Mock

const messages = {
  chat: {
    composer: {
      ghostAccept: "Accept",
      ghostDismiss: "Dismiss suggestion",
    },
  },
}

function renderControl(props: { visible: boolean; onAccept?: jest.Mock; onDismiss?: jest.Mock }) {
  const onAccept = props.onAccept ?? jest.fn()
  const onDismiss = props.onDismiss ?? jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MobileGhostAccept visible={props.visible} onAccept={onAccept} onDismiss={onDismiss} />
    </NextIntlClientProvider>
  )
  return { onAccept, onDismiss }
}

describe("MobileGhostAccept", () => {
  beforeEach(() => {
    mockImpact.mockReset()
  })

  it("renders nothing when not visible", () => {
    renderControl({ visible: false })
    expect(screen.queryByTestId("mobile-ghost-accept")).not.toBeInTheDocument()
  })

  it("renders accept and dismiss buttons when visible", () => {
    renderControl({ visible: true })
    expect(screen.getByTestId("mobile-ghost-accept-confirm")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-ghost-accept-dismiss")).toBeInTheDocument()
  })

  it("calls onAccept and fires a haptic tap on confirm", () => {
    const { onAccept } = renderControl({ visible: true })
    fireEvent.click(screen.getByTestId("mobile-ghost-accept-confirm"))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(mockImpact).toHaveBeenCalledWith("light")
  })

  it("calls onDismiss without a haptic on dismiss", () => {
    const { onDismiss } = renderControl({ visible: true })
    fireEvent.click(screen.getByTestId("mobile-ghost-accept-dismiss"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(mockImpact).not.toHaveBeenCalled()
  })

  it("labels the dismiss button for assistive tech", () => {
    renderControl({ visible: true })
    expect(screen.getByLabelText("Dismiss suggestion")).toBeInTheDocument()
  })
})
