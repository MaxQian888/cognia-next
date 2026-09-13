/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession, SdkContextUsage } from "@cognia/agent-config-types"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { useCharacter, useSkillsByIds } from "@/lib/data-hooks/context"
import { useComposerEphemeralSkillIds } from "@/stores/chat"
import { SessionCapabilitiesSection } from "./session-capabilities-section"

jest.mock("@/hooks/chat/use-sdk-context-usage", () => ({ useSdkContextUsage: jest.fn() }))
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: jest.fn(),
  useSkillsByIds: jest.fn(),
}))
jest.mock("@/stores/chat", () => ({ useComposerEphemeralSkillIds: jest.fn() }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}))

const session = {
  id: "session-1",
  characterId: "character-1",
  providerOverride: "custom",
  disabledSkillIds: ["disabled"],
} as ChatSession

describe("SessionCapabilitiesSection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest
      .mocked(useCharacter)
      .mockReturnValue({ skillIds: [] } as unknown as NonNullable<ReturnType<typeof useCharacter>>)
    jest.mocked(useSkillsByIds).mockReturnValue([])
    jest.mocked(useComposerEphemeralSkillIds).mockReturnValue([])
    jest.mocked(useSdkContextUsage).mockReturnValue({ snapshot: null, refresh: jest.fn() })
  })

  it("keeps absent runtime inventory unknown and routes management and refresh", () => {
    const onManage = jest.fn()
    render(<SessionCapabilitiesSection session={session} onManage={onManage} />)
    expect(screen.getByText("noneConfigured")).toBeInTheDocument()
    expect(screen.getByText("snapshotUnavailable")).toBeInTheDocument()
    expect(useSdkContextUsage).toHaveBeenCalledWith("session-1", "custom")
    expect(useComposerEphemeralSkillIds).toHaveBeenCalledWith("session-1")
    fireEvent.click(screen.getByRole("button", { name: "manage" }))
    fireEvent.click(screen.getByRole("button", { name: "refresh" }))
    expect(onManage).toHaveBeenCalledTimes(1)
    expect(useSdkContextUsage("session-1").refresh).toHaveBeenCalledTimes(1)
  })

  it("uses the same deduplication and disable precedence as send preparation", () => {
    jest
      .mocked(useCharacter)
      .mockReturnValue({ skillIds: ["shared", "disabled"] } as NonNullable<
        ReturnType<typeof useCharacter>
      >)
    jest.mocked(useComposerEphemeralSkillIds).mockReturnValue(["shared", "attached", "missing"])
    jest.mocked(useSkillsByIds).mockReturnValue([
      { id: "shared", name: "Shared skill" },
      { id: "disabled", name: "Disabled skill" },
      { id: "attached", name: "Attached skill" },
    ] as NonNullable<ReturnType<typeof useSkillsByIds>>)
    render(<SessionCapabilitiesSection session={session} />)
    expect(screen.getAllByText("Shared skill")).toHaveLength(1)
    expect(screen.getByText("character")).toBeInTheDocument()
    expect(screen.getByText("disabled")).toBeInTheDocument()
    expect(screen.getByText("nextMessage")).toBeInTheDocument()
    expect(screen.getByText("unresolved")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "manage" })).not.toBeInTheDocument()
    expect(screen.getByText("snapshotUnavailable")).toBeInTheDocument()
  })

  it("does not claim a missing character has no configured skills", () => {
    jest.mocked(useCharacter).mockReturnValue(undefined)
    const { rerender } = render(<SessionCapabilitiesSection session={session} />)
    expect(screen.getByText("unresolved")).toBeInTheDocument()
    expect(screen.queryByText("noneConfigured")).not.toBeInTheDocument()
    rerender(<SessionCapabilitiesSection session={{ ...session, characterId: undefined }} />)
    expect(screen.getByText("noneConfigured")).toBeInTheDocument()
  })

  it("reuses the runtime detail panel without mixing loaded and deferred tools", () => {
    jest.mocked(useSdkContextUsage).mockReturnValue({
      snapshot: {
        maxTokens: 1000,
        totalTokens: 300,
        categories: [
          { name: "System tools", tokens: 100 },
          { name: "System tools (deferred)", tokens: 50 },
          { name: "MCP tools", tokens: 80 },
          { name: "Messages", tokens: 120 },
        ],
        systemTools: [{ name: "Read", tokens: 100 }],
        deferredBuiltinTools: [{ name: "Write", tokens: 50 }],
        mcpTools: [{ name: "Search", serverName: "Docs", tokens: 80 }],
      } as SdkContextUsage,
      refresh: jest.fn(),
    })
    render(<SessionCapabilitiesSection session={session} />)
    expect(screen.getByText("detailsLive")).toBeInTheDocument()
    expect(screen.queryByText("breakdownMessages")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^breakdownTools / }))
    expect(screen.getByText("Read")).toBeInTheDocument()
    expect(screen.queryByText("Write")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /breakdownDeferred breakdownTools/ }))
    expect(screen.getByText("Write")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /breakdownMcp/ }))
    expect(screen.getByText("Docs")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^breakdownTools / }))
    expect(screen.queryByText("Read")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /detailsToggle/ }))
    expect(screen.queryByRole("button", { name: /breakdownMcp/ })).not.toBeInTheDocument()
  })

  it("does not turn a partial context snapshot into a claim that no tools are loaded", () => {
    jest.mocked(useSdkContextUsage).mockReturnValue({
      snapshot: { maxTokens: 1000, totalTokens: 200 } as SdkContextUsage,
      refresh: jest.fn(),
    })
    render(<SessionCapabilitiesSection session={session} />)
    expect(screen.getByText("inventoryUnavailable")).toBeInTheDocument()
    expect(screen.queryByText("snapshotUnavailable")).not.toBeInTheDocument()
  })
})

it("keeps compact capabilities collapsed and omits long explanations when expanded", () => {
  jest.mocked(useCharacter).mockReturnValue({ skillIds: [] } as never)
  jest.mocked(useSkillsByIds).mockReturnValue([])
  jest.mocked(useComposerEphemeralSkillIds).mockReturnValue([])
  jest.mocked(useSdkContextUsage).mockReturnValue({ snapshot: null, refresh: jest.fn() })
  const { container } = render(<SessionCapabilitiesSection session={session} compact />)
  expect(screen.getByText("configuredCount 0")).toBeInTheDocument()
  expect(screen.queryByText("snapshotUnavailable")).not.toBeInTheDocument()
  const details = container.querySelector("details")!
  details.open = true
  fireEvent(details, new Event("toggle"))
  expect(screen.getByText("snapshotUnavailable")).toBeInTheDocument()
  expect(screen.queryByText("configuredHint")).not.toBeInTheDocument()
  expect(screen.queryByText("runtimeHint")).not.toBeInTheDocument()
})
