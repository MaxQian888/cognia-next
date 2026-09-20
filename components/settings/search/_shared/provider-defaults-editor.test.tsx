import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// Shared stubs: production uses asChild/Radix portals that don't run under JSDOM.
jest.mock("@/components/ui/collapsible")
jest.mock("@/components/ui/select")

import { ProviderDefaultsEditor } from "./provider-defaults-editor"

function renderEditor(
  value: Parameters<typeof ProviderDefaultsEditor>[0]["value"] = undefined,
  providerId: Parameters<typeof ProviderDefaultsEditor>[0]["providerId"] = "tavily"
) {
  const onChange = jest.fn()
  render(
    <ProviderDefaultsEditor providerId={providerId} value={value} onChange={onChange} />
  )
  return onChange
}

/** Click the option with `data-value` inside the labeled field's select. */
function pick(fieldLabel: string, optionValue: string) {
  const label = screen.getByText(fieldLabel)
  const field = label.parentElement!
  const option = Array.from(field.querySelectorAll('[role="option"]')).find(
    (el) => el.getAttribute("data-value") === optionValue
  )
  fireEvent.click(option!)
}

describe("ProviderDefaultsEditor", () => {
  it("renders the collapsible title with no badge when nothing is overridden", () => {
    renderEditor()
    expect(screen.getByText("overrides.title")).toBeInTheDocument()
    expect(screen.queryByText(/overrides.count/)).not.toBeInTheDocument()
  })

  it("shows the active-override count badge", () => {
    renderEditor({ searchType: "news", maxResults: 10 })
    expect(screen.getByText('overrides.count:{"count":2}')).toBeInTheDocument()
  })

  it("offers only provider-supported search types", () => {
    // Tavily supports general/news but not academic/images/videos.
    renderEditor(undefined, "tavily")
    const label = screen.getByText("searchType")
    const options = Array.from(
      label.parentElement!.querySelectorAll('[role="option"]')
    ).map((el) => el.getAttribute("data-value"))
    expect(options).toContain("__inherit__")
    expect(options).toContain("general")
    expect(options).toContain("news")
    expect(options).not.toContain("academic")
    expect(options).not.toContain("videos")
  })

  it("setting a field emits the merged override object", () => {
    const onChange = renderEditor({ searchType: "news" })
    pick("searchDepth", "advanced")
    expect(onChange).toHaveBeenCalledWith({ searchType: "news", searchDepth: "advanced" })
  })

  it("choosing inherit deletes the key and emits undefined when empty", () => {
    const onChange = renderEditor({ searchType: "news" })
    pick("searchType", "__inherit__")
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("hides recency for providers without a recency filter", () => {
    // Tavily has no recencyFilter feature; Serper does.
    renderEditor(undefined, "tavily")
    expect(screen.queryByText("recency")).not.toBeInTheDocument()
  })

  it("shows recency for providers that support it", () => {
    renderEditor(undefined, "serper")
    expect(screen.getByText("recency")).toBeInTheDocument()
  })

  it("shows the three-state includeAnswer only for AI-answer providers", () => {
    renderEditor(undefined, "tavily")
    expect(screen.getByText("includeAnswer")).toBeInTheDocument()
    renderEditor(undefined, "serper")
    // Serper has no aiAnswer feature → only tavily's copy above rendered;
    // this second render must not add another.
    expect(screen.getAllByText("includeAnswer")).toHaveLength(1)
  })

  it("commits a clamped maxResults on blur and clears on blank", () => {
    const onChange = renderEditor()
    const input = screen.getByLabelText("overrides.maxResults")
    fireEvent.change(input, { target: { value: "999" } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenLastCalledWith({ maxResults: 50 })
  })

  it("blank maxResults reverts to inherit", () => {
    const onChange = renderEditor({ maxResults: 10 })
    const input = screen.getByLabelText("overrides.maxResults")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("invalid input blanks a number field and reverts to inherit", () => {
    const onChange = renderEditor({ maxResults: 10 })
    const input = screen.getByLabelText("overrides.maxResults")
    // jsdom rejects non-numeric input on type="number" → value reads "".
    fireEvent.change(input, { target: { value: "abc" } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("reflects a persisted includeAnswer override in the select value", () => {
    renderEditor({ includeAnswer: false }, "tavily")
    const label = screen.getByText("includeAnswer")
    const select = label.parentElement!.querySelector('[data-testid="select"]')
    expect(select).toHaveAttribute("data-value", "off")
  })

  it("reflects includeAnswer=true as on", () => {
    renderEditor({ includeAnswer: true }, "tavily")
    const label = screen.getByText("includeAnswer")
    const select = label.parentElement!.querySelector('[data-testid="select"]')
    expect(select).toHaveAttribute("data-value", "on")
  })

  it("writes a recency override on providers that support it", () => {
    const onChange = renderEditor(undefined, "serper")
    pick("recency", "week")
    expect(onChange).toHaveBeenCalledWith({ recency: "week" })
  })

  it("inherit clears recency and searchDepth overrides", () => {
    const onChange = renderEditor({ recency: "week", searchDepth: "deep" }, "serper")
    pick("recency", "__inherit__")
    expect(onChange).toHaveBeenLastCalledWith({ searchDepth: "deep" })
    // `value` prop is static between picks; the second inherit merges over it.
    pick("searchDepth", "__inherit__")
    expect(onChange).toHaveBeenLastCalledWith({ recency: "week" })
  })

  it("writes includeAnswer on/off and clears via inherit", () => {
    const onChange = renderEditor(undefined, "tavily")
    pick("includeAnswer", "on")
    expect(onChange).toHaveBeenLastCalledWith({ includeAnswer: true })
    pick("includeAnswer", "off")
    expect(onChange).toHaveBeenLastCalledWith({ includeAnswer: false })
    pick("includeAnswer", "__inherit__")
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
