import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrSetupWizard, hasNoCloudCredentials } from "./ocr-setup-wizard"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/lib/ocr/types"

function freshSettings(): UserOcrSettings {
  return { ...DEFAULT_OCR_SETTINGS }
}

describe("OcrSetupWizard", () => {
  it("renders only when open is true", () => {
    const { rerender } = render(
      <OcrSetupWizard
        open={false}
        onOpenChange={() => {}}
        settings={freshSettings()}
        onApply={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(screen.queryByTestId("ocr-setup-wizard")).not.toBeInTheDocument()
    rerender(
      <OcrSetupWizard
        open={true}
        onOpenChange={() => {}}
        settings={freshSettings()}
        onApply={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByTestId("ocr-setup-wizard")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-wizard-step-useCase")).toBeInTheDocument()
  })

  it("walks through the 3 steps via Next", async () => {
    const user = userEvent.setup()
    render(
      <OcrSetupWizard
        open={true}
        onOpenChange={() => {}}
        settings={freshSettings()}
        onApply={() => {}}
        onDismiss={() => {}}
      />
    )
    await user.click(screen.getByTestId("ocr-wizard-next"))
    expect(screen.getByTestId("ocr-wizard-step-preset")).toBeInTheDocument()
    await user.click(screen.getByTestId("ocr-wizard-next"))
    expect(screen.getByTestId("ocr-wizard-step-apply")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-wizard-apply")).toBeInTheDocument()
  })

  it("applies the formulas preset (mathpix lead) when chosen", async () => {
    const user = userEvent.setup()
    const onApply = jest.fn()
    render(
      <OcrSetupWizard
        open={true}
        onOpenChange={() => {}}
        settings={freshSettings()}
        onApply={onApply}
        onDismiss={() => {}}
      />
    )
    // Open select and pick "formulas".
    await user.click(screen.getByTestId("ocr-wizard-use-case-select"))
    await user.click(await screen.findByRole("option", { name: /Formulas|formulas/i }))
    await user.click(screen.getByTestId("ocr-wizard-next"))
    await user.click(screen.getByTestId("ocr-wizard-next"))
    fireEvent.click(screen.getByTestId("ocr-wizard-apply"))
    expect(onApply).toHaveBeenCalledTimes(1)
    const patch = onApply.mock.calls[0][0] as UserOcrSettings
    expect(patch.defaultProviderId).toBe("mathpix")
    expect(patch.defaultFormat).toBe("markdown")
    expect(patch.ocrWizardDismissed).toBe(true)
  })

  it("flips the dismissed flag without writing other fields when Dismiss is pressed", () => {
    const onDismiss = jest.fn()
    const onApply = jest.fn()
    render(
      <OcrSetupWizard
        open={true}
        onOpenChange={() => {}}
        settings={freshSettings()}
        onApply={onApply}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByTestId("ocr-wizard-dismiss"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe("hasNoCloudCredentials", () => {
  it("returns true when credentials map is empty", () => {
    expect(hasNoCloudCredentials({}, ["mistral-ocr"])).toBe(true)
  })

  it("returns true when entries exist but all values are blank", () => {
    expect(hasNoCloudCredentials({ "mistral-ocr": { apiKey: "  " } }, ["mistral-ocr"])).toBe(true)
  })

  it("returns false when any cloud provider has a non-empty credential", () => {
    expect(
      hasNoCloudCredentials({ "mistral-ocr": { apiKey: "sk-1234" } }, [
        "mistral-ocr",
        "aws-textract",
      ])
    ).toBe(false)
  })

  it("ignores non-cloud providers", () => {
    expect(hasNoCloudCredentials({ "tesseract-wasm": { unused: "value" } }, ["mistral-ocr"])).toBe(
      true
    )
  })
})
