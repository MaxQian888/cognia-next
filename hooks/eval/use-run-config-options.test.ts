import { renderHook, waitFor } from "@testing-library/react"
import { useRunConfigOptions } from "./use-run-config-options"

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

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: { settings: unknown }) => unknown) =>
    sel({ settings: { providerSettings: undefined, customProviders: undefined } }),
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

it("folds models, characters, teams and workflows into RunConfigOptions", async () => {
  const { result } = renderHook(() => useRunConfigOptions())
  await waitFor(() => expect(result.current.workflows).toEqual([{ id: "wf1", name: "Pipeline" }]))
  // duplicate model ids across providers are de-duplicated
  expect(result.current.models).toEqual(["claude-opus-4-8"])
  expect(result.current.characters).toEqual([{ id: "ch1", name: "Ava" }])
  expect(result.current.teams).toEqual([{ id: "tm1", name: "Core" }])
})
