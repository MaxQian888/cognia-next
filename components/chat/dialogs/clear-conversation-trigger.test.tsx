// Coverage for the header's clear-conversation trigger: gating on
// session/messages, the confirm→clear flow, and error handling.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"

import { ClearConversationTrigger } from "./clear-conversation-trigger"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useChatStore } from "@/stores/chat"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => undefined,
    useSkillsByIds: () => [],
    usePresets: () => [],
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

// TooltipProvider is mounted app-wide in app/layout.tsx; the trigger's
// TooltipIconButton needs it present in tests too.
function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ClearTriggerTestWrapper"
  return Wrapper
}

const userMsg = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
})

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("ses_1")
  act(() => {
    useChatStore.getState().replaceMessages([userMsg("m1")])
  })
})

describe("ClearConversationTrigger", () => {
  it("renders nothing when there are no messages", () => {
    act(() => {
      useChatStore.getState().replaceMessages([])
    })
    const { container } = render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <ClearConversationTrigger />
      </DataAdapterProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when there is no active session", () => {
    act(() => {
      useChatStore.getState().setActiveSession(null)
    })
    const { container } = render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <ClearConversationTrigger />
      </DataAdapterProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a labeled outline button for the sheet variant and still opens the confirm dialog", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ClearConversationTrigger variant="labeled" className="w-full" />
      </Wrapper>
    )
    const trigger = screen.getByRole("button", { name: /clear/i })
    expect(trigger).toHaveClass("w-full")
    expect(trigger).toHaveTextContent(/clear/i)
    fireEvent.click(trigger)
    expect(await screen.findByRole("button", { name: /delete messages/i })).toBeInTheDocument()
  })

  it("confirms then calls adapter.clearMessages with the active sessionId", async () => {
    const clearMessages = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )

    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => expect(clearMessages).toHaveBeenCalledWith("ses_1"))
  })

  it("surfaces clear errors without crashing", async () => {
    const clearMessages = jest.fn(async () => {
      throw new Error("boom")
    })
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(clearMessages).toHaveBeenCalled())
  })

  it("handles a non-Error clear rejection without crashing", async () => {
    const clearMessages = jest.fn(async () => {
      throw "string failure"
    })
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(clearMessages).toHaveBeenCalled())
  })
})
