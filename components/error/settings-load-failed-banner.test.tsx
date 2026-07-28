import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SettingsLoadFailedBanner } from "./settings-load-failed-banner"
import { useSettingsStore } from "@/stores/settings"

const realRetryLoad = useSettingsStore.getState().retryLoad

beforeEach(() => {
  useSettingsStore.setState({ loadFailed: false, loadError: null, retryLoad: realRetryLoad })
})

describe("SettingsLoadFailedBanner", () => {
  it("renders nothing while settings loaded normally", () => {
    const { container } = render(<SettingsLoadFailedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("surfaces the degraded state once load() fell back to defaults", () => {
    useSettingsStore.setState({ loadFailed: true, loadError: null })
    render(<SettingsLoadFailedBanner />)

    expect(screen.getByTestId("settings-load-failed-banner")).toBeInTheDocument()
    expect(screen.getByText("Running on default settings")).toBeInTheDocument()
    // No raw failure text means no details disclosure to open.
    expect(screen.queryByTestId("settings-load-failed-detail")).not.toBeInTheDocument()
  })

  it("exposes the raw failure text under a details disclosure", () => {
    useSettingsStore.setState({ loadFailed: true, loadError: "DatabaseClosedError: db closed" })
    render(<SettingsLoadFailedBanner />)

    expect(screen.getByTestId("settings-load-failed-detail")).toHaveTextContent(
      "DatabaseClosedError: db closed"
    )
  })

  it("retries the load and disables the control while in flight", async () => {
    let release: () => void = () => {}
    const retryLoad = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    useSettingsStore.setState({ loadFailed: true, loadError: "boom", retryLoad })
    render(<SettingsLoadFailedBanner />)

    await userEvent.click(screen.getByTestId("settings-load-failed-retry"))
    expect(retryLoad).toHaveBeenCalledTimes(1)

    const button = screen.getByTestId("settings-load-failed-retry")
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent("Retrying…")

    release()
    await waitFor(() => expect(screen.getByTestId("settings-load-failed-retry")).toBeEnabled())
    expect(screen.getByTestId("settings-load-failed-retry")).toHaveTextContent("Retry")
  })

  it("disappears once a retry restores the real settings", async () => {
    const retryLoad = jest.fn(async () => {
      useSettingsStore.setState({ loadFailed: false, loadError: null })
    })
    useSettingsStore.setState({ loadFailed: true, loadError: "boom", retryLoad })
    const { container } = render(<SettingsLoadFailedBanner />)

    await userEvent.click(screen.getByTestId("settings-load-failed-retry"))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
