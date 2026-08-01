/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ProviderDiagnosticsTab } from "./provider-diagnostics-tab"

const save = jest.fn(async () => undefined)
const resolveTargets = jest.fn()
const startJob = jest.fn(async (_input?: unknown) => ({ status: "completed" }))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, initial: unknown) => initial,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {
        id: "singleton",
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            apiKey: "secret",
            baseURL: "https://api.openai.com/v1",
            defaultModel: "gpt-5.4",
          },
        },
      },
      save,
    }),
}))

jest.mock("@/lib/provider-diagnostics/targets", () => ({
  resolveProviderDiagnosticTargets: (...args: unknown[]) => resolveTargets(args[0]),
}))

jest.mock("@/lib/provider-diagnostics/service", () => ({
  startProviderDiagnosticJob: (...args: unknown[]) => startJob(args[0]),
  cancelProviderDiagnosticJob: jest.fn(),
  cancelProviderDiagnosticTarget: jest.fn(),
}))

describe("ProviderDiagnosticsTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveTargets.mockResolvedValue([
      {
        id: "openai:probe:primary:endpoint",
        providerId: "openai",
        credentialFingerprint: "credential:openai:primary",
        endpoint: "https://api.openai.com/v1",
        capability: "probe",
        credentials: { protocol: "openai", apiKey: "secret" },
        estimatedMaxCostUsd: 0,
        billable: false,
      },
    ])
  })

  it("renders the responsive control rail and complete result workspaces", () => {
    render(
      <ProviderDiagnosticsTab
        providerId="openai"
        providerName="OpenAI"
        modelIds={["gpt-5.4"]}
        defaultModel="gpt-5.4"
      />
    )

    expect(screen.getByText("summary.title")).toBeInTheDocument()
    expect(screen.getAllByTestId("diagnostics-run-composer")).toHaveLength(1)
    expect(screen.getByText("matrix.title")).toBeInTheDocument()
    expect(screen.getByText("balance.title")).toBeInTheDocument()
    expect(screen.getByText("endpoints.title")).toBeInTheDocument()
    expect(screen.getByText("history.title")).toBeInTheDocument()
  })

  it("shows the request/cost confirmation before starting even a free probe", async () => {
    render(
      <ProviderDiagnosticsTab
        providerId="openai"
        providerName="OpenAI"
        modelIds={["gpt-5.4"]}
        defaultModel="gpt-5.4"
      />
    )

    fireEvent.click(screen.getAllByRole("button", { name: "composer.reviewRun" })[0])
    expect(await screen.findByText("confirm.title")).toBeInTheDocument()
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", capability: "probe" })
    )

    fireEvent.click(screen.getByRole("button", { name: "confirm.runFree" }))
    await waitFor(() => expect(startJob).toHaveBeenCalled())
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ providerDiagnostics: expect.any(Object) })
    )
  })
})
