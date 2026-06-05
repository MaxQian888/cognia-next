import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RoutingTestPanel } from "./routing-test-panel"
import { DEFAULT_ROUTING_CONFIG } from "@/types/provider/model-mapping"

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      modelMappings: [
        {
          id: "m1",
          alias: "fast",
          providers: [
            { providerId: "groq", modelId: "llama" },
            { providerId: "openai", modelId: "gpt-4o-mini" },
          ],
          distribution: "priority",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
      providerSettings: {},
      customProviders: [],
    },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

describe("RoutingTestPanel", () => {
  it("previews an alias through the real engine and shows the chain", async () => {
    const user = userEvent.setup()
    render(<RoutingTestPanel />)
    await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "fast")
    await user.click(screen.getByRole("button", { name: /Preview/ }))

    const result = await screen.findByTestId("preview-result")
    expect(result).toBeInTheDocument()
    // quality strategy = first entry (appears in the resolved badge AND the chain).
    expect(screen.getAllByText("groq:llama").length).toBeGreaterThan(0)
    expect(screen.getByTestId("fallback-chain")).toBeInTheDocument()
  })

  it("shows no-match for an unknown alias", async () => {
    const user = userEvent.setup()
    render(<RoutingTestPanel />)
    await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "nope{Enter}")
    expect(await screen.findByTestId("preview-no-match")).toBeInTheDocument()
  })
})
