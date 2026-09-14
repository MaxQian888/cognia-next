/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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

  it("re-arms authorization when the target is edited after consent", () => {
    // The checkbox asserts consent for THIS target — letting it survive an
    // edit would carry consent to a different system.
    setup()
    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "https://a" } })
    fireEvent.click(screen.getByTestId("strix-authorized"))
    expect(screen.getByTestId("strix-start")).toBeEnabled()

    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "https://b" } })
    expect(screen.getByTestId("strix-start")).toBeDisabled()
  })

  it("applies remembered defaults on first render", () => {
    setup({ defaultTarget: "https://saved", defaultModel: "openai/gpt-5" })
    expect(screen.getByTestId("strix-target")).toHaveValue("https://saved")
    expect(screen.getByTestId("strix-model")).toHaveValue("openai/gpt-5")
  })

  it("tucks model + api key behind the Advanced disclosure, closed by default", async () => {
    const user = userEvent.setup()
    setup()
    // Radix Collapsible unmounts closed content entirely.
    expect(screen.queryByTestId("strix-model")).not.toBeInTheDocument()

    await user.click(screen.getByTestId("strix-advanced-toggle"))
    expect(screen.getByTestId("strix-model")).toBeVisible()
    expect(screen.getByTestId("strix-apikey")).toBeVisible()
  })

  it("opens Advanced when a remembered model override exists", () => {
    setup({ defaultModel: "openai/gpt-5" })
    expect(screen.getByTestId("strix-model")).toBeVisible()
  })

  it("passes the model + session-only api key through to onStart", async () => {
    const user = userEvent.setup()
    const { onStart } = setup()
    await user.click(screen.getByTestId("strix-advanced-toggle"))
    fireEvent.change(screen.getByTestId("strix-model"), {
      target: { value: "openai/gpt-5" },
    })
    fireEvent.change(screen.getByTestId("strix-apikey"), {
      target: { value: "sk-session" },
    })
    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "https://x" } })
    fireEvent.click(screen.getByTestId("strix-authorized"))

    await user.click(screen.getByTestId("strix-start"))
    expect(onStart).toHaveBeenCalledWith({
      target: "https://x",
      model: "openai/gpt-5",
      apiKey: "sk-session",
    })
  })

  it("omits blank optional overrides from the submitted options", async () => {
    const user = userEvent.setup()
    const { onStart } = setup()
    await user.click(screen.getByTestId("strix-advanced-toggle"))
    fireEvent.change(screen.getByTestId("strix-model"), { target: { value: "   " } })
    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: "https://x" } })
    fireEvent.click(screen.getByTestId("strix-authorized"))

    await user.click(screen.getByTestId("strix-start"))
    expect(onStart).toHaveBeenCalledWith({
      target: "https://x",
      model: undefined,
      apiKey: undefined,
    })
  })
})
