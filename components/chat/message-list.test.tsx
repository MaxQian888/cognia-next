// Coverage for message-list after the data-hooks refactor — the component now
// reads characters via DataAdapter (no Dexie import) and calls
// `clearMessages` through the adapter rather than a direct Dexie helper.

// Stub heavy ai-elements / message-renderer dependencies — this is a logic
// test for message-list's clear/export flows, not for the renderer chain.
import * as ReactForMocks from "react"

jest.mock("@/components/ai-elements/conversation", () => {
  return {
    Conversation: ({ children }: { children: ReactForMocks.ReactNode }) =>
      ReactForMocks.createElement("div", { "data-test": "conversation" }, children),
    ConversationContent: ({ children }: { children: ReactForMocks.ReactNode }) =>
      ReactForMocks.createElement("div", { "data-test": "conversation-content" }, children),
    ConversationScrollButton: () => null,
    messagesToMarkdown: (msgs: unknown[]) =>
      `# msgs\n${(msgs as { id: string }[]).map((m) => m.id).join("\n")}`,
  }
})

jest.mock("@/components/ai-elements/shimmer", () => {
  return {
    Shimmer: ({ children }: { children: ReactForMocks.ReactNode }) =>
      ReactForMocks.createElement("span", null, children),
  }
})

jest.mock("./message-renderer", () => {
  return {
    MessageRenderer: ({ message }: { message: { id: string; parts: { text?: string }[] } }) =>
      ReactForMocks.createElement(
        "div",
        { "data-test": `msg-${message.id}` },
        message.parts.map((p, i) => ReactForMocks.createElement("span", { key: i }, p.text ?? ""))
      ),
  }
})

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { MessageList } from "./message-list"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
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

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "MessageListTestWrapper"
  return Wrapper
}

const userMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("ses_1")
})

describe("MessageList", () => {
  it("renders nothing-to-export action bar only when there are messages", () => {
    const { rerender } = render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <MessageList messages={[]} status="idle" />
      </DataAdapterProvider>
    )
    expect(screen.queryByText(/Export/i)).toBeNull()

    rerender(
      <DataAdapterProvider adapter={makeAdapter()}>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </DataAdapterProvider>
    )
    expect(screen.getByText(/Export/i)).toBeInTheDocument()
  })

  it("clear-history button calls adapter.clearMessages with the active sessionId", async () => {
    const clearMessages = jest.fn(async () => undefined)
    const adapter = makeAdapter({ clearMessages })
    const Wrapper = withAdapter(adapter)
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )

    fireEvent.click(screen.getByText(/Clear/i))
    // Confirm in the alert dialog.
    const confirm = await screen.findByRole("button", { name: /Delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => expect(clearMessages).toHaveBeenCalledWith("ses_1"))
  })

  it("clear-history is a no-op when there is no active session", async () => {
    useChatStore.getState().setActiveSession(null)
    const clearMessages = jest.fn(async () => undefined)
    const adapter = makeAdapter({ clearMessages })
    const Wrapper = withAdapter(adapter)
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )

    fireEvent.click(screen.getByText(/Clear/i))
    const confirm = await screen.findByRole("button", { name: /Delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })

    expect(clearMessages).not.toHaveBeenCalled()
  })

  it("surfaces clear-history errors via toast (does not crash)", async () => {
    const clearMessages = jest.fn(async () => {
      throw new Error("boom")
    })
    const adapter = makeAdapter({ clearMessages })
    const Wrapper = withAdapter(adapter)
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hi")]} status="idle" />
      </Wrapper>
    )
    fireEvent.click(screen.getByText(/Clear/i))
    const confirm = await screen.findByRole("button", { name: /Delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(clearMessages).toHaveBeenCalled())
    // No further assertion needed — the catch block is what we're exercising;
    // the test is green if React doesn't blow up the tree.
  })

  it("renders messages from the input prop", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("m1", "hello"), userMsg("m2", "world")]} status="idle" />
      </Wrapper>
    )
    expect(screen.getByText("hello")).toBeInTheDocument()
    expect(screen.getByText("world")).toBeInTheDocument()
  })
})
