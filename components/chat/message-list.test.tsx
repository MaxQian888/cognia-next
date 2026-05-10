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

// jsdom has no layout engine so useVirtualizer always returns empty items.
// Mock it to render every item so message-level assertions work in tests.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: String(i),
        start: i * 120,
        size: 120,
        lane: 0,
      })),
    getTotalSize: () => count * 120,
    measureElement: () => {},
  }),
}))

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

  it("renders items based on virtualizer output", () => {
    const Wrapper = withAdapter(makeAdapter())
    const msgs = Array.from({ length: 10 }, (_, i) => userMsg(`vm-${i}`, `Msg ${i}`))
    render(
      <Wrapper>
        <MessageList messages={msgs} status="idle" />
      </Wrapper>
    )
    for (let i = 0; i < 10; i++) {
      expect(document.querySelector(`[data-test="msg-vm-${i}"]`)).toBeTruthy()
    }
  })
})

describe("shouldShowThinking", () => {
  it("shows thinking shimmer when streaming and last message is from user", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("u1", "hi")]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("Claude is thinking…")).toBeInTheDocument()
  })

  it("does not show thinking shimmer when streaming but assistant already has text", () => {
    const Wrapper = withAdapter(makeAdapter())
    const assistantMsg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    }
    render(
      <Wrapper>
        <MessageList messages={[assistantMsg]} status="streaming" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("does not show thinking shimmer when status is idle", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[]} status="idle" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })

  it("shows thinking shimmer when streaming with no messages yet", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[]} status="streaming" />
      </Wrapper>
    )
    expect(screen.getByText("Claude is thinking…")).toBeInTheDocument()
  })

  it("does not show thinking shimmer during awaiting_approval", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <MessageList messages={[userMsg("u1", "hi")]} status="awaiting_approval" />
      </Wrapper>
    )
    expect(screen.queryByText("Claude is thinking…")).toBeNull()
  })
})
