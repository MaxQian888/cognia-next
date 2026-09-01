/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { Command } from "@/components/ui/command"
import { ProviderModelList } from "./provider-model-list"
import type { ModelOptionGroup } from "@cognia/provider-routing/model-option-source"

const groups: ModelOptionGroup[] = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    models: ["claude-opus-5", "claude-sonnet-5"],
  },
  { providerId: "deepseek", providerName: "DeepSeek", models: ["deepseek-chat"] },
]

function renderList(props: Partial<React.ComponentProps<typeof ProviderModelList>> = {}) {
  const onSelect = jest.fn()
  render(
    // The list is a body, not a container: cmdk ownership stays with whichever
    // picker mounts it.
    <Command>
      <ProviderModelList
        groups={groups}
        searchPlaceholder="Search models"
        emptyLabel="No models"
        onSelect={onSelect}
        {...props}
      />
    </Command>
  )
  return { onSelect }
}

describe("ProviderModelList", () => {
  it("groups models under their provider", () => {
    renderList()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("DeepSeek")).toBeInTheDocument()
    expect(screen.getAllByTestId("provider-model-option")).toHaveLength(3)
  })

  it("reports the provider alongside the model, because an id is not unique", () => {
    const { onSelect } = renderList()
    fireEvent.click(screen.getByText("deepseek-chat"))
    expect(onSelect).toHaveBeenCalledWith("deepseek", "deepseek-chat")
  })

  it("marks the active row only when BOTH provider and model match", () => {
    renderList({ activeProviderId: "anthropic", activeModelId: "claude-opus-5" })
    const active = screen
      .getAllByTestId("provider-model-option")
      .filter((row) => row.getAttribute("data-active") === "true")
    expect(active).toHaveLength(1)
    expect(active[0]).toHaveTextContent("claude-opus-5")
  })

  it("does not mark a same-id model that belongs to another provider", () => {
    renderList({ activeProviderId: "deepseek", activeModelId: "claude-opus-5" })
    expect(
      screen.queryAllByTestId("provider-model-option").filter((r) => r.dataset.active === "true")
    ).toHaveLength(0)
  })

  it("filters on the provider id as well as the model id", () => {
    renderList()
    fireEvent.change(screen.getByPlaceholderText("Search models"), {
      target: { value: "deepseek" },
    })
    expect(screen.getAllByTestId("provider-model-option")).toHaveLength(1)
  })

  it("says there are no models rather than rendering an empty frame", () => {
    renderList({ groups: [] })
    expect(screen.getByText("No models")).toBeInTheDocument()
    expect(screen.queryAllByTestId("provider-model-option")).toHaveLength(0)
  })

  it("offers no trailing row unless the caller asks for one", () => {
    renderList()
    expect(screen.queryByTestId("provider-model-footer")).toBeNull()
  })

  it("runs the trailing row's action, and disables it when it would be a no-op", () => {
    const onFooter = jest.fn()
    renderList({
      footer: { label: "Use chat model", value: "__inherit__", onSelect: onFooter },
    })
    fireEvent.click(screen.getByTestId("provider-model-footer"))
    expect(onFooter).toHaveBeenCalled()
  })

  it("hides the trailing row when there is nothing to list at all", () => {
    // No groups means no frame, and a lone "clear" row under an empty list is
    // an action pointing at nothing.
    renderList({
      groups: [],
      footer: { label: "Clear", value: "__clear__", onSelect: jest.fn() },
    })
    expect(screen.queryByTestId("provider-model-footer")).toBeNull()
  })
})
