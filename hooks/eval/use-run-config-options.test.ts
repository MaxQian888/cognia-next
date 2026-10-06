import { renderHook, waitFor } from "@testing-library/react"
import { useRunConfigOptions, useEvalRunConfiguration } from "./use-run-config-options"

// Async-aware useLiveQuery stub: starts at the default, resolves the querier
// promise into state (the real hook re-emits the same way).
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => Promise<unknown>, _deps: unknown[], def: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest factory scope
    const React = require("react") as typeof import("react")
    const [value, setValue] = React.useState(def)
    React.useEffect(() => {
      void Promise.resolve(querier()).then(setValue)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
    }, [])
    return value
  },
}))

let appSettings: import("@cognia/agent-config-types").AppSettings | null = null
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: { settings: unknown }) => unknown) => sel({ settings: appSettings }),
}))
jest.mock("@/lib/ai/model-options", () => ({
  collectModelOptions: () => [
    { providerId: "anthropic", providerName: "anthropic", modelId: "claude-opus-4-8" },
    { providerId: "deepseek", providerName: "deepseek", modelId: "claude-opus-4-8" },
  ],
}))
jest.mock("@/lib/db/characters", () => ({
  listCharacters: async () => [{ id: "ch1", name: "Ava" }],
}))
jest.mock("@/lib/db/teams", () => ({ listTeams: async () => [{ id: "tm1", name: "Core" }] }))
jest.mock("@/lib/db/workflows", () => ({
  listWorkflowsByUpdated: async () => [{ id: "wf1", name: "Pipeline" }],
}))
jest.mock("@/lib/db/twins", () => ({ listTwins: async () => [{ id: "tw1", name: "Alice" }] }))

it("folds models, characters, teams and workflows into RunConfigOptions", async () => {
  const { result } = renderHook(() => useRunConfigOptions())
  await waitFor(() => expect(result.current.workflows).toEqual([{ id: "wf1", name: "Pipeline" }]))
  // duplicate model ids across providers are de-duplicated
  expect(result.current.models).toEqual(["claude-opus-4-8"])
  expect(result.current.characters).toEqual([{ id: "ch1", name: "Ava" }])
  expect(result.current.teams).toEqual([{ id: "tm1", name: "Core" }])
  expect(result.current.twins).toEqual([{ id: "tw1", name: "Alice" }])
})

const buildConfiguredRunDeps = jest.fn(() => ({ deterministicOnly: false }))
const runEvalService = jest.fn(async () => ({ reports: [], deterministicOnly: false }))
jest.mock("@/lib/ai/eval/browser-deps", () => ({
  buildConfiguredRunDeps: (...args: unknown[]) => buildConfiguredRunDeps(...(args as [])),
}))
jest.mock("@/lib/ai/eval/service", () => ({
  runEvalService: (...args: unknown[]) => runEvalService(...(args as [])),
}))

describe("useEvalRunConfiguration", () => {
  beforeEach(() => {
    appSettings = null
    buildConfiguredRunDeps.mockClear()
    runEvalService.mockClear()
  })

  it("exposes only presentation defaults and routes execution through the configured service", async () => {
    appSettings = {
      defaultModel: "target-model",
      evalSettings: { defaultK: 3, judgeModel: "judge-model", deterministicOnly: true },
      providerSettings: { secret: { apiKey: "private" } },
    } as unknown as import("@cognia/agent-config-types").AppSettings
    const { result, rerender } = renderHook(() => useEvalRunConfiguration())
    expect(result.current).toMatchObject({
      defaultModel: "target-model",
      evalSettings: { defaultK: 3 },
      deterministicOnly: false,
    })
    expect(result.current).not.toHaveProperty("appSettings")
    expect(result.current).not.toHaveProperty("providerSettings")
    expect(buildConfiguredRunDeps).toHaveBeenCalledWith({
      appSettings,
      judgeModel: "judge-model",
      forceDeterministic: true,
    })
    const input = {
      datasetId: "d",
      config: { targets: [], scorerIds: [], k: 1 },
      signal: new AbortController().signal,
      onProgress: jest.fn(),
    }
    await result.current.run(input)
    expect(runEvalService).toHaveBeenLastCalledWith({
      ...input,
      appSettings,
      judgeModel: "judge-model",
      forceDeterministic: true,
    })

    appSettings = {
      defaultModel: "next-model",
      evalSettings: { judgeModel: "next-judge" },
    } as import("@cognia/agent-config-types").AppSettings
    rerender()
    expect(result.current.defaultModel).toBe("next-model")
    await result.current.run(input)
    expect(runEvalService).toHaveBeenLastCalledWith({
      ...input,
      appSettings,
      judgeModel: "next-judge",
    })
  })

  it("keeps default target and sanitized settings when the host has no settings", () => {
    const { result } = renderHook(() => useEvalRunConfiguration())
    expect(result.current.defaultModel).toBe("claude-opus-4-8")
    expect(result.current.evalSettings.defaultK).toBe(1)
  })
})
