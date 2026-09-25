import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DecisionProvider, DecisionResult } from "@/types/decisions"

const save = jest.fn()
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = (key: string) => key === "plugin.laya.decisionProvider.label"
    return t
  },
}))

let mockProviders: DecisionProvider[] = []
jest.mock("@/hooks/decisions/use-decision-providers", () => ({
  useDecisionProviders: () => mockProviders,
  useDecisionProvider: (id?: string) => mockProviders.find((p) => p.id === id),
}))

const hasDecisionHttpKey = jest.fn(async () => false)
const setDecisionHttpKey = jest.fn(async () => {})
jest.mock("@/lib/decisions/config", () => ({
  hasDecisionHttpKey: (...args: unknown[]) => hasDecisionHttpKey(...(args as [])),
  setDecisionHttpKey: (...args: unknown[]) => setDecisionHttpKey(...(args as [])),
}))

const runDecision = jest.fn<Promise<DecisionResult>, unknown[]>()
jest.mock("@/lib/decisions/run-decision", () => ({
  runDecision: (...args: unknown[]) => runDecision(...args),
}))
jest.mock("@/lib/decisions/providers/decisions-http", () => ({
  BUILTIN_HTTP_PROVIDER_ID: "builtin:decisions-http",
}))

import { DECISION_PROBE_REQUEST, DecisionProviderCard } from "./decision-provider-card"

function provider(overrides: Partial<DecisionProvider>): DecisionProvider {
  return {
    id: "builtin:decisions-http",
    label: "Remote decisions endpoint",
    locality: "remote",
    calibrated: true,
    decide: async () => ({ ok: true, answers: {} }),
    status: async () => ({ ready: true }),
    ...overrides,
  }
}

const laya = provider({
  id: "laya:laya-local",
  label: "Laya (local)",
  labelKey: "decisionProvider.label",
  pluginId: "laya",
  locality: "local",
  status: async () => ({ ready: false, loading: true }),
})

beforeEach(() => {
  save.mockReset()
  runDecision.mockReset()
  setDecisionHttpKey.mockReset()
  hasDecisionHttpKey.mockReset()
  hasDecisionHttpKey.mockResolvedValue(false)
  mockProviders = [provider({}), laya]
  mockSettings = { decisions: {} }
})

describe("DecisionProviderCard", () => {
  it("labels the no-provider state explicitly and lists installed providers", () => {
    render(<DecisionProviderCard />)
    const select = screen.getByLabelText("provider.label") as HTMLSelectElement
    expect(select.value).toBe("")
    expect(screen.getByText("provider.noneHint")).toBeInTheDocument()
    const options = Array.from(select.options).map((o) => o.textContent)
    // Built-in is i18n'd; the plugin label resolves through the plugin bundle key.
    expect(options).toEqual([
      "provider.none",
      "builtinRemote",
      "plugin.laya.decisionProvider.label",
    ])
    expect(screen.queryByText("test.button")).not.toBeInTheDocument()
  })

  it("saves the selected provider", async () => {
    const user = userEvent.setup()
    render(<DecisionProviderCard />)
    await user.selectOptions(screen.getByLabelText("provider.label"), "laya:laya-local")
    expect(save).toHaveBeenCalledWith({ decisions: { providerId: "laya:laya-local" } })
  })

  it("shows traits and live status of a plugin provider", async () => {
    mockSettings = { decisions: { providerId: "laya:laya-local" } }
    render(<DecisionProviderCard />)
    expect(screen.getByText("traits.local")).toBeInTheDocument()
    expect(screen.getByText("traits.calibrated")).toBeInTheDocument()
    // laya declares no validated question set: not offered as a copilot judge.
    expect(screen.getByText("traits.copilotNotValidated")).toBeInTheDocument()
    expect(await screen.findByText("status.loading")).toBeInTheDocument()
    // Remote endpoint fields only belong to the built-in provider.
    expect(screen.queryByLabelText("http.preset")).not.toBeInTheDocument()
  })

  it("flags a selected provider that is no longer installed", () => {
    mockSettings = { decisions: { providerId: "gone:x" } }
    render(<DecisionProviderCard />)
    expect(screen.getByText("provider.missing")).toBeInTheDocument()
    expect(screen.getByText("test.button").closest("button")).toBeDisabled()
  })

  it("edits the remote endpoint and reports configuration problems", async () => {
    const user = userEvent.setup()
    mockSettings = {
      decisions: { providerId: "builtin:decisions-http", http: { preset: "custom" } },
    }
    render(<DecisionProviderCard />)
    expect(screen.getByText("http.problems.no_url")).toBeInTheDocument()
    // A custom URL is not a model anyone measured on the copilot's questions.
    expect(screen.getByText("traits.copilotNotValidated")).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText("http.preset"), "bocha")
    expect(save).toHaveBeenLastCalledWith({
      decisions: { providerId: "builtin:decisions-http", http: { preset: "bocha" } },
    })
    await user.type(screen.getByLabelText("http.model"), "m")
    expect(save).toHaveBeenLastCalledWith({
      decisions: { providerId: "builtin:decisions-http", http: { preset: "custom", model: "m" } },
    })
  })

  it("stores the key in the keyring and surfaces keyring failures", async () => {
    const user = userEvent.setup()
    mockSettings = { decisions: { providerId: "builtin:decisions-http", http: { preset: "zen" } } }
    render(<DecisionProviderCard />)
    expect(screen.getByText("traits.copilotValidated")).toBeInTheDocument()
    await user.type(screen.getByLabelText("http.key"), "sk-1")
    await user.click(screen.getByText("http.saveKey"))
    expect(setDecisionHttpKey).toHaveBeenCalledWith("zen", "sk-1")
    expect(save).not.toHaveBeenCalled() // never written to settings
    setDecisionHttpKey.mockRejectedValueOnce(new Error("passphrase"))
    await user.type(screen.getByLabelText("http.key"), "sk-2")
    await user.click(screen.getByText("http.saveKey"))
    expect(await screen.findByText("http.keyringUnavailable")).toBeInTheDocument()
  })

  it("shows a saved key without revealing it", async () => {
    hasDecisionHttpKey.mockResolvedValue(true)
    mockSettings = { decisions: { providerId: "builtin:decisions-http", http: { preset: "zen" } } }
    render(<DecisionProviderCard />)
    await waitFor(() =>
      expect(screen.getByLabelText("http.key")).toHaveAttribute("placeholder", "http.keySaved")
    )
    expect(screen.getByText("http.clearKey")).toBeInTheDocument()
  })

  it("runs the probe through runDecision and reports success or the typed error", async () => {
    const user = userEvent.setup()
    mockSettings = { decisions: { providerId: "laya:laya-local" } }
    runDecision.mockResolvedValueOnce({
      ok: true,
      providerId: "laya:laya-local",
      answers: {},
      latencyMs: 61,
    })
    render(<DecisionProviderCard />)
    await user.click(screen.getByText("test.button"))
    expect(runDecision).toHaveBeenCalledWith(DECISION_PROBE_REQUEST, {
      providerId: "laya:laya-local",
    })
    expect(await screen.findByText('test.ok:{"latencyMs":61}')).toBeInTheDocument()
    runDecision.mockResolvedValueOnce({
      ok: false,
      error: { kind: "provider_unavailable", message: "loading" },
    })
    await user.click(screen.getByText("test.button"))
    expect(await screen.findByText("errors.provider_unavailable")).toBeInTheDocument()
  })
})
