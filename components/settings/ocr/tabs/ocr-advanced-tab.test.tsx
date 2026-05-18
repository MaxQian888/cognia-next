import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrAdvancedTab } from "./ocr-advanced-tab"

function setup(
  providerId: string,
  config: Record<string, unknown> = {},
  onConfigChange = jest.fn(),
  onClearProviderCache = jest.fn()
) {
  render(
    <OcrAdvancedTab
      providerId={providerId}
      config={config}
      onConfigChange={onConfigChange}
      onClearProviderCache={onClearProviderCache}
    />
  )
  return { onConfigChange, onClearProviderCache }
}

describe("OcrAdvancedTab", () => {
  it("shows region only for aws-textract / azure-document-intelligence", () => {
    const { unmount } = render(
      <OcrAdvancedTab
        providerId="aws-textract"
        config={{}}
        onConfigChange={() => {}}
        onClearProviderCache={() => {}}
      />
    )
    expect(screen.getByTestId("ocr-adv-region")).toBeInTheDocument()
    unmount()

    render(
      <OcrAdvancedTab
        providerId="azure-document-intelligence"
        config={{}}
        onConfigChange={() => {}}
        onClearProviderCache={() => {}}
      />
    )
    expect(screen.getByTestId("ocr-adv-region")).toBeInTheDocument()
  })

  it("hides region for providers that don't have one", () => {
    setup("mistral-ocr")
    expect(screen.queryByTestId("ocr-adv-region")).not.toBeInTheDocument()
  })

  it("shows modelVariant only for declared providers", () => {
    setup("mistral-ocr")
    expect(screen.getByTestId("ocr-adv-model-variant")).toBeInTheDocument()
  })

  it("hides modelVariant for ocr-space", () => {
    setup("ocr-space")
    expect(screen.queryByTestId("ocr-adv-model-variant")).not.toBeInTheDocument()
  })

  it("shows promptTemplate only for LLM-vision providers", () => {
    setup("anthropic-vision")
    expect(screen.getByTestId("ocr-adv-prompt-template")).toBeInTheDocument()
  })

  it("hides promptTemplate for non-vision providers", () => {
    setup("mistral-ocr")
    expect(screen.queryByTestId("ocr-adv-prompt-template")).not.toBeInTheDocument()
  })

  it("writes format override into the config blob", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr")
    const trigger = screen.getByLabelText(/Output format override/i)
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: /Plain text/i }))
    expect(onConfigChange).toHaveBeenCalled()
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.format).toBe("text")
  })

  it("clears the format field when the user picks 'Inherit global'", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr", { format: "text" })
    const trigger = screen.getByLabelText(/Output format override/i)
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: /Inherit/i }))
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.format).toBeUndefined()
  })

  it("writes languages override and clears it when emptied", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr")
    const input = screen.getByLabelText(/Languages override/i)
    await user.type(input, "zh")
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.languages).toBeDefined()
  })

  it("writes modelVariant override", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr")
    await user.type(screen.getByLabelText(/Model variant/i), "x")
    expect(onConfigChange).toHaveBeenCalled()
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.modelVariant).toBe("x")
  })

  it("writes region override", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("aws-textract")
    await user.type(screen.getByLabelText(/^Region/i), "u")
    expect(onConfigChange).toHaveBeenCalled()
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.region).toBe("u")
  })

  it("writes promptTemplate override", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("anthropic-vision")
    await user.type(screen.getByLabelText(/Prompt template/i), "h")
    expect(onConfigChange).toHaveBeenCalled()
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.promptTemplate).toBe("h")
  })

  it("resets all overrides via the Reset button", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr", { format: "text", languages: "zh" })
    await user.click(screen.getByTestId("ocr-adv-reset"))
    expect(onConfigChange).toHaveBeenCalledWith({})
  })

  it("fires onClearProviderCache when the clear-cache button is clicked", async () => {
    const user = userEvent.setup()
    const { onClearProviderCache } = setup("mistral-ocr")
    await user.click(screen.getByTestId("ocr-adv-clear-cache"))
    expect(onClearProviderCache).toHaveBeenCalledTimes(1)
  })
})
