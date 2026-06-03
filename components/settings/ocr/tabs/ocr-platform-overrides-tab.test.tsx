import { fireEvent, render, screen } from "@testing-library/react"
import { OcrPlatformOverridesTab } from "./ocr-platform-overrides-tab"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"

function freshSettings(): UserOcrSettings {
  return { ...DEFAULT_OCR_SETTINGS, platformOverrides: {} }
}

describe("OcrPlatformOverridesTab", () => {
  it("renders the Windows bucket with DEFAULT_LOCAL_PREFERENCE entries", () => {
    render(<OcrPlatformOverridesTab settings={freshSettings()} onChange={jest.fn()} />)
    expect(screen.getByTestId("ocr-os-tab-windows")).toBeInTheDocument()
    // Windows default starts with windows-media-ocr.
    expect(screen.getByTestId("ocr-engine-row-windows-media-ocr")).toBeInTheDocument()
  })

  it("uses the override list when one is set", () => {
    const settings: UserOcrSettings = {
      ...freshSettings(),
      platformOverrides: { windows: ["ocrs", "tesseract-wasm"] },
    }
    render(<OcrPlatformOverridesTab settings={settings} onChange={jest.fn()} />)
    expect(screen.getByTestId("ocr-engine-row-ocrs")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-engine-row-tesseract-wasm")).toBeInTheDocument()
    // windows-media-ocr was excluded by the user override.
    expect(screen.queryByTestId("ocr-engine-row-windows-media-ocr")).not.toBeInTheDocument()
  })

  it("removes an engine from the active bucket on row remove", () => {
    const onChange = jest.fn()
    const settings: UserOcrSettings = {
      ...freshSettings(),
      platformOverrides: { windows: ["ocrs", "tesseract-wasm"] },
    }
    render(<OcrPlatformOverridesTab settings={settings} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("ocr-engine-remove-ocrs"))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as UserOcrSettings
    expect(next.platformOverrides?.windows).toEqual(["tesseract-wasm"])
  })

  it("reset button clears the override for that bucket only", () => {
    const onChange = jest.fn()
    const settings: UserOcrSettings = {
      ...freshSettings(),
      platformOverrides: {
        windows: ["ocrs"],
        linux: ["tesseract-wasm"],
      },
    }
    render(<OcrPlatformOverridesTab settings={settings} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("ocr-os-reset-windows"))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as UserOcrSettings
    expect(next.platformOverrides?.windows).toBeUndefined()
    expect(next.platformOverrides?.linux).toEqual(["tesseract-wasm"])
  })

  it("reset button is disabled when no override is in effect", () => {
    render(<OcrPlatformOverridesTab settings={freshSettings()} onChange={jest.fn()} />)
    expect(screen.getByTestId("ocr-os-reset-windows")).toBeDisabled()
  })
})
