/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const planMock = jest.fn()
const applyMock = jest.fn()
jest.mock("@/lib/ccswitch/switch", () => ({
  planSwitch: (...args: unknown[]) => planMock(...args),
  applySwitch: (...args: unknown[]) => applyMock(...args),
}))

const getSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ProviderSwitchDialog } from "./provider-switch-dialog"
import type { CcswitchProvider } from "@/lib/ccswitch/types"

const provider: CcswitchProvider = {
  id: "p1",
  name: "Kimi K2",
  apiKey: "sk-moon",
  baseUrl: "https://api.moonshot.cn",
}

const samplePlan = {
  provider,
  scope: { cognia: true as const, agents: [] },
  cogniaChanges: {
    apiKeyBefore: undefined,
    apiKeyAfter: "sk-moon",
    baseUrlBefore: undefined,
    baseUrlAfter: "https://api.moonshot.cn",
    activeProviderIdBefore: undefined,
    activeProviderIdAfter: "ccswitch:p1",
    restartSidecar: true,
  },
  agentChanges: [],
}

beforeEach(() => {
  jest.resetAllMocks()
  planMock.mockReturnValue(samplePlan)
  getSettingsMock.mockResolvedValue({
    id: "singleton",
    apiKey: undefined,
    apiBaseUrl: undefined,
    activeProviderId: undefined,
    alwaysAllowTools: [],
    builtinTools: {},
  })
})

function renderDialog(overrides: Partial<React.ComponentProps<typeof ProviderSwitchDialog>> = {}) {
  return render(
    <ProviderSwitchDialog provider={provider} open={true} onOpenChange={() => {}} {...overrides} />
  )
}

describe("ProviderSwitchDialog", () => {
  it("renders the cognia changes diff after planning", async () => {
    renderDialog()
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    // The dialog should render the section labels.
    expect(await screen.findByText("dialog.cogniaSection")).toBeInTheDocument()
    expect(screen.getByText("dialog.willRestart")).toBeInTheDocument()
  })

  it("masks the API key in the diff", async () => {
    renderDialog()
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    // mask should never echo the full secret
    expect(screen.queryByText("sk-moon")).toBeNull()
  })

  it("Apply button calls applySwitch with the plan", async () => {
    applyMock.mockResolvedValue({
      cogniaApplied: true,
      agentResults: [],
    })
    const onApplied = jest.fn()
    renderDialog({ onApplied })
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "dialog.confirm" }))
    await waitFor(() => expect(applyMock).toHaveBeenCalled())
    expect(onApplied).toHaveBeenCalledWith({ cogniaApplied: true, agentResults: [] })
  })

  it("toggling an agent updates the plan input", async () => {
    renderDialog()
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    planMock.mockClear()
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    // The most-recent plan call should include at least one agent in the scope.
    const lastCall = planMock.mock.calls.at(-1)!
    const scope = lastCall[1]
    expect(scope.agents.length).toBeGreaterThan(0)
  })

  it("renders nothing when the provider is null", () => {
    render(<ProviderSwitchDialog provider={null} open={true} onOpenChange={() => {}} />)
    // The dialog header still renders (Radix), but no plan diff section appears.
    expect(screen.queryByText("dialog.cogniaSection")).toBeNull()
  })
})
