import { fireEvent, render, screen } from "@testing-library/react"
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
  it("renders provider fields from OCR_PARAMETER_SCHEMAS", () => {
    setup("local-http")
    expect(screen.getByLabelText(/Endpoint/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Request dialect/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Timeout \(ms\)/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Confirm private LAN access/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument()
  })

  it("binds LAN confirmation to the exact current endpoint", async () => {
    const user = userEvent.setup()
    const endpoint = "http://192.168.1.20:1224/api/ocr"
    const { onConfigChange } = setup("local-http", { endpoint })
    await user.click(screen.getByLabelText(/Confirm private LAN access/i))
    expect(onConfigChange.mock.calls.at(-1)![0]).toMatchObject({
      allowLan: true,
      confirmedLanEndpoint: endpoint,
    })

    fireEvent.change(screen.getByLabelText(/Endpoint/i), {
      target: { value: "http://192.168.1.21:1224/api/ocr" },
    })
    expect(onConfigChange.mock.calls.at(-1)![0]).toMatchObject({ allowLan: false })
    expect(onConfigChange.mock.calls.at(-1)![0].confirmedLanEndpoint).toBeUndefined()
  })

  it("renders provider-specific fields without leaking fields from another provider", () => {
    setup("aws-textract")
    expect(screen.getByLabelText(/^Region/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Extract tables/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Prompt template/i)).not.toBeInTheDocument()
  })

  it("writes the canonical model field and removes a legacy modelVariant", () => {
    const { onConfigChange } = setup("mistral-ocr", { modelVariant: "legacy" })
    const input = screen.getByLabelText(/^Model/i)
    fireEvent.change(input, { target: { value: "current" } })
    const last = onConfigChange.mock.calls.at(-1)![0]
    expect(last.model).toBe("current")
    expect(last.modelVariant).toBeUndefined()
  })

  it("defaults PaddleOCR to v6-small and lets the user select v6-tiny", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("paddle-ocr")
    const trigger = screen.getByLabelText(/^Model/i)
    expect(trigger).toHaveTextContent("v6-small")
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: "v6-tiny" }))
    expect(onConfigChange.mock.calls.at(-1)![0].model).toBe("v6-tiny")
  })

  it("writes schema-backed format and language overrides", async () => {
    const user = userEvent.setup()
    const { onConfigChange } = setup("mistral-ocr")
    const format = screen.getByLabelText(/Output format/i)
    await user.click(format)
    await user.click(await screen.findByRole("option", { name: /Plain text/i }))
    expect(onConfigChange.mock.calls.at(-1)![0].format).toBe("text")

    fireEvent.change(screen.getByLabelText(/^Languages/i), { target: { value: "zh" } })
    expect(onConfigChange.mock.calls.at(-1)![0].languages).toBe("zh")
  })

  it("renders and writes the LLM prompt template", () => {
    const { onConfigChange } = setup("anthropic-vision", { promptTemplate: "old" })
    const input = screen.getByLabelText(/Prompt template/i)
    fireEvent.change(input, { target: { value: "new" } })
    expect(onConfigChange.mock.calls.at(-1)![0].promptTemplate).toBe("new")
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
