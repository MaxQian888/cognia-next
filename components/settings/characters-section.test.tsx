/**
 * @jest-environment jsdom
 *
 * Settings → Agent packs & knowledge (ADR-0220): the agents themselves live on
 * `/agents`, so this section shows an entry card that leads there, the
 * character packs, and the reusable knowledge bases.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && "count" in values ? `${key}:${String(values.count)}` : key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock("@/components/settings/knowledge-base-manager", () => ({
  KnowledgeBaseManager: () => null,
}))

let mockAgentCount = 0
let mockKnowledgeBases: Array<{ id: string; name: string; createdAt: number; updatedAt: number }> =
  []
const mockCreateKnowledgeBase = jest.fn(async (..._args: unknown[]) => undefined)

jest.mock("dexie-react-hooks", () => ({
  // Synchronous stand-in: the query fns below return plain values.
  useLiveQuery: (fn: () => unknown) => {
    const value = fn()
    return value instanceof Promise ? mockAgentCount : value
  },
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

jest.mock("@/lib/db/characters", () => ({
  listResolvedCharacters: async () => Array.from({ length: mockAgentCount }),
}))
jest.mock("@/lib/db/knowledge-bases", () => ({
  listKnowledgeBases: () => mockKnowledgeBases,
  createKnowledgeBase: (...args: unknown[]) => mockCreateKnowledgeBase(...args),
  getKnowledgeBaseReferences: jest.fn(async () => []),
}))
jest.mock("@/lib/knowledge-base/ingest/ingest-source", () => ({
  removeKnowledgeBase: jest.fn(async () => undefined),
}))
jest.mock("@/lib/project-knowledge/runtime/build-deps", () => ({
  tryBuildProjectKnowledgeDeps: jest.fn(async () => undefined),
}))
jest.mock("@/hooks/plugins/use-plugin-metadata", () => ({ usePluginMetadata: () => undefined }))

import type React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CharactersSection } from "./characters-section"
import {
  __resetCharacterPacksForTesting,
  refreshAllPackWarnings,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import { __resetSkillsForTesting, registerSkill } from "@/lib/plugin/registries/skill-registry"

afterEach(() => {
  __resetCharacterPacksForTesting()
  __resetSkillsForTesting()
  mockAgentCount = 0
  mockKnowledgeBases = []
  mockCreateKnowledgeBase.mockClear()
})

describe("CharactersSection", () => {
  it("leads to the agents console, saying how many agents are there", () => {
    mockAgentCount = 4
    render(<CharactersSection />)
    expect(screen.getByTestId("agents-entry-card")).toHaveTextContent("agentsEntry.description:4")
    expect(screen.getByRole("link", { name: /agentsEntry\.open/ })).toHaveAttribute(
      "href",
      "/agents"
    )
  })

  it("no longer lists or edits agents itself", () => {
    render(<CharactersSection />)
    expect(screen.queryByPlaceholderText("searchPlaceholder")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "newCharacter" })).not.toBeInTheDocument()
  })

  it("creates a reusable Knowledge Base from the Agent settings surface", async () => {
    render(<CharactersSection />)

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "Product docs" },
    })
    fireEvent.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() =>
      expect(mockCreateKnowledgeBase).toHaveBeenCalledWith({ name: "Product docs" })
    )
  })

  it("immediately renders packs registered after the settings screen mounted", () => {
    render(<CharactersSection />)
    expect(screen.queryByText("Reactive Pack")).not.toBeInTheDocument()

    act(() => {
      registerCharacterPack(
        "reactive-pack",
        {
          id: "reactive-pack",
          name: "Reactive Pack",
          version: "1.0.0",
          characters: [],
        },
        { pluginId: "test-plugin" }
      )
    })

    expect(screen.getByText("Reactive Pack")).toBeInTheDocument()
  })

  it("removes a rendered dependency warning when the registry refreshes", () => {
    render(<CharactersSection />)

    act(() => {
      registerCharacterPack(
        "waiting-pack",
        {
          id: "waiting-pack",
          name: "Waiting Pack",
          version: "1.0.0",
          characters: [],
          requires: { skills: ["later-skill"] },
        },
        { pluginId: "test-plugin" }
      )
    })
    expect(screen.getByText(/badge\.missingDep/)).toBeInTheDocument()

    act(() => {
      registerSkill("later-skill", {
        id: "later-skill",
        name: "Later skill",
        description: "",
        source: { kind: "inline", markdown: "" },
      })
      refreshAllPackWarnings()
    })

    expect(screen.queryByText(/badge\.missingDep/)).not.toBeInTheDocument()
  })
})
