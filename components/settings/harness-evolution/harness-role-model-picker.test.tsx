/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { providerSettings: { openai: {} }, customProviders: [] } }),
}))
jest.mock("@cognia/provider-routing/model-option-source", () => ({
  collectOptions: () => [
    { providerId: "openai", providerName: "OpenAI", modelId: "gpt-x" },
    { providerId: "openai", providerName: "OpenAI", modelId: "gpt-y" },
  ],
  groupByProvider: (o: unknown[]) => [{ providerId: "openai", providerName: "OpenAI", models: o }],
}))
let mockListProps: {
  onSelect: (p: string, m: string) => void
  footer: { onSelect: () => void; disabled: boolean }
} | null = null
jest.mock("@/components/settings/provider/provider-model-list", () => ({
  ProviderModelList: (props: NonNullable<typeof mockListProps>) => {
    mockListProps = props
    return <div data-testid="model-list" />
  },
}))
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}))

import { HarnessRoleModelPicker } from "./harness-role-model-picker"

describe("HarnessRoleModelPicker", () => {
  it("shows the agent's model when unset and reports a picked provider + model", () => {
    const onChange = jest.fn()
    render(<HarnessRoleModelPicker role="editor" value={undefined} onChange={onChange} />)
    expect(screen.getByTestId("harness-role-model-editor")).toHaveTextContent("The agent's model")
    expect(mockListProps?.footer.disabled).toBe(true)
    mockListProps?.onSelect("openai", "gpt-y")
    expect(onChange).toHaveBeenCalledWith({ providerId: "openai", model: "gpt-y" })
  })

  it("clears back to the agent's model and flags a model nobody offers", () => {
    const onChange = jest.fn()
    render(
      <HarnessRoleModelPicker
        role="selector"
        value={{ providerId: "openai", model: "gone" }}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("harness-role-model-selector")).toHaveTextContent("gone")
    expect(screen.getByTestId("harness-role-model-invalid-selector")).toBeInTheDocument()
    mockListProps?.footer.onSelect()
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
