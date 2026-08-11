import { fireEvent, render, screen } from "@testing-library/react"

import { GatewayExposurePanel } from "./exposure-panel"
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup(over: Partial<GatewayConfig> = {}) {
  const persist = jest.fn().mockResolvedValue(undefined)
  render(
    <GatewayExposurePanel
      ctx={{
        config: { ...DEFAULT_GATEWAY_CONFIG, ...over },
        status: null,
        persist,
        replace: jest.fn(),
        restartRequired: false,
      }}
    />
  )
  return { persist }
}

describe("GatewayExposurePanel", () => {
  it("appends an exposed model", () => {
    const { persist } = setup()

    const input = screen.getByLabelText("exposedModels")
    fireEvent.change(input, { target: { value: "gpt-4o" } })
    fireEvent.blur(input)

    expect(persist).toHaveBeenCalledWith({ exposedModels: ["gpt-4o"] })
  })

  it("says everything is exposed while the allowlist is empty", () => {
    setup({ exposedModels: [] })
    expect(screen.getByText("exposedModelsAll")).toBeInTheDocument()
  })

  it("switches the help text once the list is non-empty", () => {
    setup({ exposedModels: ["fast"] })
    expect(screen.getByText("exposedModelsHelp")).toBeInTheDocument()
    expect(screen.queryByText("exposedModelsAll")).not.toBeInTheDocument()
  })

  it("toggles hide-raw-provider-models", () => {
    const { persist } = setup()

    fireEvent.click(screen.getByRole("switch", { name: "hideRawModels" }))

    expect(persist).toHaveBeenCalledWith({ hideRawProviderModels: true })
  })
})
