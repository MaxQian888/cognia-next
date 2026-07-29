/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UnsavedBar } from "./unsaved-bar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

const noop = () => {}

beforeEach(() => {
  flowMotion = { reduce: false, durationScale: 1 }
})

describe("UnsavedBar", () => {
  it("renders nothing while clean — the panel should look idle", () => {
    render(<UnsavedBar status="clean" count={0} onSave={noop} onDiscard={noop} />)
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("appears with save and discard once dirty", () => {
    render(<UnsavedBar status="dirty" count={3} onSave={noop} onDiscard={noop} />)
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
    expect(screen.getByTestId("unsaved-bar-save")).toBeEnabled()
    expect(screen.getByTestId("unsaved-bar-discard")).toBeEnabled()
  })

  it("invokes the callbacks", async () => {
    const onSave = jest.fn()
    const onDiscard = jest.fn()
    render(<UnsavedBar status="dirty" count={1} onSave={onSave} onDiscard={onDiscard} />)
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await userEvent.click(screen.getByTestId("unsaved-bar-discard"))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it("locks both buttons while saving so a double-submit cannot land", () => {
    render(<UnsavedBar status="saving" count={2} onSave={noop} onDiscard={noop} />)
    expect(screen.getByTestId("unsaved-bar-save")).toBeDisabled()
    expect(screen.getByTestId("unsaved-bar-discard")).toBeDisabled()
  })

  it("swaps to a confirmation with no action buttons once saved", () => {
    render(<UnsavedBar status="saved" count={0} onSave={noop} onDiscard={noop} />)
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "saved")
    expect(screen.queryByTestId("unsaved-bar-save")).not.toBeInTheDocument()
    expect(screen.queryByTestId("unsaved-bar-discard")).not.toBeInTheDocument()
  })

  it("still renders its content under reduced motion", () => {
    flowMotion = { reduce: true, durationScale: 1 }
    render(<UnsavedBar status="dirty" count={1} onSave={noop} onDiscard={noop} />)
    expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument()
  })

  it("renders nothing under reduced motion while clean", () => {
    flowMotion = { reduce: true, durationScale: 1 }
    render(<UnsavedBar status="clean" count={0} onSave={noop} onDiscard={noop} />)
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })
})
