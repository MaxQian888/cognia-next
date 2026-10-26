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
  canSwitchProvider: jest.requireActual("@/lib/ccswitch/switch").canSwitchProvider,
  applySwitch: (...args: unknown[]) => applyMock(...args),
}))

const getSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ProviderSwitchDialog } from "./provider-switch-dialog"
import type { CcswitchProvider } from "@/types/ccswitch"

const provider: CcswitchProvider = {
  id: "p1",
  kind: "claude",
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
    activeProviderIdAfter: "ccswitch:claude:p1",
    restartSidecar: true,
    useSubscription: false,
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

  it("previews the subscription reuse note for an official provider plan", async () => {
    planMock.mockReturnValue({
      ...samplePlan,
      cogniaChanges: { ...samplePlan.cogniaChanges, useSubscription: true },
    })
    renderDialog()
    expect(await screen.findByText("dialog.useSubscription")).toBeInTheDocument()
  })

  it("hides the subscription note for keyed providers", async () => {
    renderDialog()
    await screen.findByText("dialog.cogniaSection")
    expect(screen.queryByText("dialog.useSubscription")).toBeNull()
  })

  it.each([
    [{ activated: true, source: "vault" }, "dialog.subscriptionActivated"],
    [{ activated: true, source: "adopted" }, "dialog.subscriptionAdopted"],
    [{ activated: false, error: "none-found" }, "dialog.subscriptionNoneFound"],
    [
      { activated: false, error: "vault sealed" },
      'dialog.subscriptionFailed:{"error":"vault sealed"}',
    ],
  ])("renders the subscription apply outcome %j", async (subscription, expected) => {
    applyMock.mockResolvedValue({ cogniaApplied: true, agentResults: [], subscription })
    renderDialog()
    await waitFor(() => expect(planMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "dialog.confirm" }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it("renders nothing when the provider is null", () => {
    render(<ProviderSwitchDialog provider={null} open={true} onOpenChange={() => {}} />)
    // The dialog header still renders (Radix), but no plan diff section appears.
    expect(screen.queryByText("dialog.cogniaSection")).toBeNull()
  })
})

it("surfaces an apply error and keeps the switch available to retry", async () => {
  applyMock.mockRejectedValue(new Error("write failed"))
  renderDialog()
  const confirm = await screen.findByRole("button", { name: "dialog.confirm" })
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
  expect(await screen.findByRole("alert")).toHaveTextContent("dialog.applyFailed")
  expect(confirm).toBeEnabled()
})

it("does not label failed subscription activation as an applied switch", async () => {
  applyMock.mockResolvedValue({
    cogniaApplied: false,
    agentResults: [],
    subscription: { activated: false, error: "none-found" },
  })
  renderDialog()
  const confirm = await screen.findByRole("button", { name: "dialog.confirm" })
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
  expect(await screen.findByText("dialog.cogniaNotApplied")).toBeInTheDocument()
  expect(screen.queryByText("dialog.cogniaApplied")).not.toBeInTheDocument()
})

it("offers only compatible propagation targets and drops obsolete saved selections", async () => {
  renderDialog({ initialAgents: ["codex", "gemini", "claude-code"] })
  await screen.findByText("dialog.cogniaSection")
  expect(screen.queryByText("agents.codex")).not.toBeInTheDocument()
  expect(screen.queryByText("agents.gemini")).not.toBeInTheDocument()
  expect(screen.getByText("agents.opencode")).toBeInTheDocument()
  expect(planMock.mock.calls.at(-1)![1].agents).toEqual(["claude-code"])
})
it("passes previous relay headers into restart planning", async () => {
  const customHeaders = { "anthropic-beta": "context-1m-test" }
  getSettingsMock.mockResolvedValue({ providerSettings: { anthropic: { customHeaders } } })
  renderDialog()
  await waitFor(() =>
    expect(planMock).toHaveBeenCalledWith(
      provider,
      expect.anything(),
      expect.objectContaining({ customHeaders })
    )
  )
})
it("previews OpenCode's credential-only propagation limitation", async () => {
  planMock.mockReturnValue({
    ...samplePlan,
    agentChanges: [
      {
        agentId: "opencode",
        unsupported: false,
        targetPath: "~/.local/share/opencode/auth.json",
        envUpdates: [],
      },
    ],
  })
  renderDialog({ initialAgents: ["opencode"] })
  expect(await screen.findByText("dialog.baseUrlNotPropagated")).toBeInTheDocument()
})
