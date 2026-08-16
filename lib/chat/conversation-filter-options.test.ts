import {
  EMPTY_CONVERSATION_FILTER_OPTIONS,
  buildConversationFilterOptions,
  hasConversationFilterOptions,
} from "@/lib/chat/conversation-filter-options"
import { CONVERSATION_FILTER_UNASSIGNED } from "@/lib/chat/conversation-filters"
import type { ChatSession } from "@cognia/agent-config-types"

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt: 1, ...overrides } as ChatSession
}

const sessions = [
  session("a", { projectId: "w1", folderId: "f1", characterId: "c1", model: "claude" }),
  session("b", { projectId: "w1", characterId: "c1", providerOverride: "openai", model: "gpt" }),
  session("c", { projectId: "w2", characterId: "c2" }),
  session("d", { kind: "team", teamId: "t1", projectId: "w1" }),
  session("e", {}),
]

const workspaces = [
  { id: "w2", name: "Beta" },
  { id: "w1", name: "Alpha" },
  { id: "w9", name: "Ghost" },
]

describe("buildConversationFilterOptions", () => {
  it("returns the shared empty identity for no sessions and no selection", () => {
    expect(buildConversationFilterOptions({ sessions: [] })).toBe(EMPTY_CONVERSATION_FILTER_OPTIONS)
    expect(hasConversationFilterOptions(EMPTY_CONVERSATION_FILTER_OPTIONS, "models")).toBe(false)
  })

  it("lists entity-backed facets in entity order with counts, dropping unused entities and trailing the unassigned row", () => {
    const options = buildConversationFilterOptions({ sessions, workspaces })
    expect(options.workspaceIds).toEqual([
      { value: "w2", label: "Beta", count: 1 },
      { value: "w1", label: "Alpha", count: 3 },
      { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
    ])
    expect(hasConversationFilterOptions(options, "workspaceIds")).toBe(true)
  })

  it("keeps values referenced by sessions but no longer backed by an entity, labelled by id", () => {
    const options = buildConversationFilterOptions({
      sessions,
      workspaces: [{ id: "w1", name: "Alpha" }],
    })
    expect(options.workspaceIds.map((o) => o.value)).toEqual([
      "w1",
      "w2",
      CONVERSATION_FILTER_UNASSIGNED,
    ])
    expect(options.workspaceIds[1]).toEqual({ value: "w2", label: "w2", count: 1 })
  })

  it("keeps selected values with a zero count so they can be un-ticked", () => {
    const options = buildConversationFilterOptions({
      sessions,
      workspaces,
      selected: {
        workspaceIds: ["w9", "gone", CONVERSATION_FILTER_UNASSIGNED],
        models: ["mistral"],
      },
    })
    expect(options.workspaceIds).toEqual([
      { value: "w2", label: "Beta", count: 1 },
      { value: "w1", label: "Alpha", count: 3 },
      { value: "w9", label: "Ghost", count: 0 },
      { value: "gone", label: "gone", count: 0 },
      { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
    ])
    expect(options.models).toContainEqual({ value: "mistral", label: "mistral", count: 0 })
  })

  it("excludes team conversations from the agent tally and never offers unassigned for teams", () => {
    const options = buildConversationFilterOptions({
      sessions,
      agents: [
        { id: "c1", name: "One" },
        { id: "c2", name: "Two" },
      ],
      teams: [{ id: "t1", name: "Squad" }],
    })
    expect(options.agentIds).toEqual([
      { value: "c1", label: "One", count: 2 },
      { value: "c2", label: "Two", count: 1 },
      // Only "e" — the team row "d" does not count as "no agent".
      { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
    ])
    expect(options.teamIds).toEqual([{ value: "t1", label: "Squad", count: 1 }])
  })

  it("resolves models / providers through the row value then the fallback chain, sorted by usage then label", () => {
    const options = buildConversationFilterOptions({
      sessions,
      context: { modelOf: () => "claude", providerOf: () => "anthropic" },
      labelModel: (id) => id.toUpperCase(),
      labelProvider: (id) => `P:${id}`,
    })
    expect(options.models).toEqual([
      { value: "claude", label: "CLAUDE", count: 4 },
      { value: "gpt", label: "GPT", count: 1 },
    ])
    expect(options.providers).toEqual([
      { value: "anthropic", label: "P:anthropic", count: 4 },
      { value: "openai", label: "P:openai", count: 1 },
    ])
  })

  it("leaves models / providers empty when nothing resolves", () => {
    const options = buildConversationFilterOptions({ sessions: [session("x")] })
    expect(options.models).toHaveLength(0)
    expect(options.providers).toHaveLength(0)
    expect(options.folderIds).toEqual([
      { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
    ])
  })
})
