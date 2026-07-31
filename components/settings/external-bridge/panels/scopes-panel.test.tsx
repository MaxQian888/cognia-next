import { fireEvent, render, screen } from "@testing-library/react"

import { BridgeScopesPanel, PHASE_1_DISABLED_SCOPES } from "./scopes-panel"
import { ALL_BRIDGE_SCOPES, type ExternalBridgeSettings } from "@/types/wiki"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

function setup(over: Partial<ExternalBridgeSettings> = {}) {
  const onChange = jest.fn()
  const settings: ExternalBridgeSettings = {
    enabled: true,
    enabledScopes: ["wiki:cognia"],
    ...over,
  } as ExternalBridgeSettings
  render(<BridgeScopesPanel settings={settings} onChange={onChange} />)
  return { onChange }
}

describe("BridgeScopesPanel", () => {
  it("renders every scope — all nineteen, not the nine the old header claimed", () => {
    setup()

    expect(ALL_BRIDGE_SCOPES.length).toBe(19)
    for (const scope of ALL_BRIDGE_SCOPES) {
      expect(screen.getByTestId(`bridge-scope-row-${scope}`)).toBeInTheDocument()
    }
  })

  it("buckets scopes under namespace headings", () => {
    setup()

    expect(screen.getByTestId("bridge-scope-group-wiki")).toBeInTheDocument()
    expect(screen.getByTestId("bridge-scope-group-runtime")).toBeInTheDocument()
    expect(screen.getByTestId("bridge-scope-group-memory")).toBeInTheDocument()
  })

  it("grants a scope", () => {
    const { onChange } = setup({ enabledScopes: [] })

    fireEvent.click(screen.getByRole("switch", { name: "scopes.toggleAria:rag:cognia" }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ enabledScopes: ["rag:cognia"] })
    )
  })

  it("revokes a granted scope", () => {
    const { onChange } = setup({ enabledScopes: ["wiki:cognia", "rag:cognia"] })

    fireEvent.click(screen.getByRole("switch", { name: "scopes.toggleAria:wiki:cognia" }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ enabledScopes: ["rag:cognia"] })
    )
  })

  // Working Rule 7, third axis. These two were already rendered disabled with
  // no explanation at all — the type documented the deferral, the UI did not.
  it.each(PHASE_1_DISABLED_SCOPES)(
    "labels %s as planned rather than silently disabled",
    (scope) => {
      setup()

      expect(screen.getByTestId(`bridge-scope-planned-${scope}`)).toHaveTextContent(
        "scopes.plannedBadge"
      )
      expect(screen.getByRole("switch", { name: `scopes.toggleAria:${scope}` })).toBeDisabled()
    }
  )

  it("explains why a planned scope cannot be granted", () => {
    setup()
    expect(screen.getAllByText("scopes.plannedReason").length).toBe(PHASE_1_DISABLED_SCOPES.length)
  })

  it("refuses to grant a planned scope even if the handler is invoked directly", () => {
    const { onChange } = setup({ enabledScopes: [] })

    fireEvent.click(screen.getByRole("switch", { name: "scopes.toggleAria:wiki:user-repo" }))

    expect(onChange).not.toHaveBeenCalled()
  })

  it("counts granted scopes against the total", () => {
    setup({ enabledScopes: ["wiki:cognia", "rag:cognia"] })
    expect(
      screen.getByText(`scopes.grantedCount:2,${ALL_BRIDGE_SCOPES.length}`)
    ).toBeInTheDocument()
  })
})
