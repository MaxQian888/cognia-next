import { fireEvent, render, screen } from "@testing-library/react"
import { getSchemaForProvider } from "@cognia/provider-core/providers/provider-parameter-schemas"
import type { UserProviderSettings } from "@cognia/provider-types"
import { ProviderParametersTab } from "./provider-parameters-tab"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const settings: UserProviderSettings = {
  providerId: "custom-openai",
  enabled: true,
  defaultModel: "gpt-compatible",
}

describe("ProviderParametersTab", () => {
  it("renders an inherited custom-provider schema and reports source-neutral updates", () => {
    const onSettingsChange = jest.fn()
    const schema = getSchemaForProvider("custom-openai", {
      "custom-openai": { apiProtocol: "openai", name: "Private Gateway" },
    })

    render(
      <ProviderParametersTab
        providerId="custom-openai"
        settings={settings}
        schema={schema}
        onSettingsChange={onSettingsChange}
      />
    )

    fireEvent.click(screen.getByText("advanced"))
    fireEvent.change(screen.getByLabelText("openai.seed.label"), {
      target: { value: "42", valueAsNumber: 42 },
    })

    expect(onSettingsChange).toHaveBeenCalledWith({
      advancedParams: { "openai.seed": 42 },
    })
  })

  it("clears provider concurrency with the connection reset", () => {
    const onSettingsChange = jest.fn()
    render(
      <ProviderParametersTab
        providerId="openai"
        settings={{
          ...settings,
          providerId: "openai",
          connectionParams: { concurrentLimit: 3 },
        }}
        onSettingsChange={onSettingsChange}
      />
    )

    fireEvent.click(screen.getAllByTitle("resetAll")[2])

    expect(onSettingsChange).toHaveBeenCalledWith({
      connectionParams: {
        concurrentLimit: undefined,
        maxRetries: undefined,
      },
    })
  })
})
