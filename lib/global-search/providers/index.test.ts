import { KIND_SCOPES, type GlobalSearchKind } from "../types"
import { __resetGlobalSearchRegistryForTesting, listGlobalSearchProviders } from "../registry"
import { builtinGlobalSearchProviders, registerBuiltinGlobalSearchProviders } from "./index"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn(async () => []) }))
jest.mock("@/lib/db/memories", () => ({ listMemories: jest.fn(async () => []) }))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflowsByUpdated: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn(async () => []) }))
jest.mock("@/lib/scheduler/scheduler-data-source", () => ({
  getSchedulerDataSource: () => ({ listTasks: jest.fn(async () => []) }),
}))
jest.mock("@/lib/templates/catalog", () => ({
  templateCatalog: { getSnapshot: () => ({ revision: 0, definitions: [] }) },
}))
jest.mock("@/lib/chat/search/engine", () => ({
  searchChatHistory: jest.fn(async () => ({
    results: [],
    moreOlderHistory: false,
    indexIncomplete: false,
  })),
}))

describe("built-in provider roster", () => {
  beforeEach(() => __resetGlobalSearchRegistryForTesting())

  it("covers every kind exactly once with unique ids", () => {
    const providers = builtinGlobalSearchProviders()
    const kinds = providers.map((p) => p.kind).sort()
    const expected = (Object.keys(KIND_SCOPES) as GlobalSearchKind[]).sort()
    expect(kinds).toEqual(expected)
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length)
    expect(providers.every((p) => p.id.startsWith("builtin."))).toBe(true)
  })

  it("registers idempotently and threads message deps through", () => {
    const pendingRows = jest.fn(() => [])
    const ids = registerBuiltinGlobalSearchProviders({ messages: { pendingRows } })
    expect(listGlobalSearchProviders().map((p) => p.id)).toEqual(ids)
    registerBuiltinGlobalSearchProviders()
    expect(listGlobalSearchProviders()).toHaveLength(ids.length)
  })
})
