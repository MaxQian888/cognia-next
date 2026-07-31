import { render } from "@testing-library/react"
import { CaptureMount } from "./capture-mount"

// The clipboard watcher + settings store are exercised elsewhere; here we only
// assert the mount renders (bubble hidden by default) without throwing.
jest.mock("@/hooks/capture/use-clipboard-capture", () => ({ useClipboardCapture: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: {} }),
}))

describe("CaptureMount", () => {
  it("renders without a pending capture", () => {
    const { container } = render(<CaptureMount />)
    expect(container).toBeEmptyDOMElement()
  })
})
