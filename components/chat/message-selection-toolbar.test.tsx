/** @jest-environment jsdom */
import { createRef } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"

import enChat from "@/i18n/messages/en/chat.json"
import enToolbar from "@/i18n/messages/en/selectionToolbar.json"
import type { SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { useChatStore } from "@/stores/chat/chat-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import {
  MessageSelectionToolbar,
  messageRowsInRange,
  useTranscriptSelection,
} from "./message-selection-toolbar"

const mockCreate = jest.fn()
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  createResourceWorkbenchSession: (...a: unknown[]) => mockCreate(...(a as [])),
}))

const setSessionOverride = jest.fn()
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: { getState: () => ({ setSessionOverride }) },
}))

const revealSidechat = jest.fn()
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealSidechat }) },
}))

const mockBuildExcerpt = jest.fn()
jest.mock("@/lib/chat/selection/message-excerpt", () => ({
  buildMessageExcerptSelection: (...a: unknown[]) => mockBuildExcerpt(...(a as [])),
}))

const mockSetPref = jest.fn(async () => undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(async () => null),
  setPref: (...a: unknown[]) => mockSetPref(...(a as [])),
}))

const mockRun = jest.fn()
const mockStop = jest.fn()
const mockClose = jest.fn()
let mockRunState: SelectionRunState = { status: "idle" }
jest.mock("@/hooks/chat/use-selection-action-run", () => ({
  useSelectionActionRun: () => ({
    state: mockRunState,
    run: mockRun,
    stop: mockStop,
    close: mockClose,
  }),
}))

// Radix's radio group does not route a jsdom click or Enter to `onValueChange`
// (the menu closes without selecting), so the menu is reduced to what this
// component relies on: items that report their value to the group.
jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Group = React.createContext<(value: string) => void>(() => undefined)
  const pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children)
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    DropdownMenuLabel: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: React.ReactNode
      onValueChange: (value: string) => void
    }) => React.createElement(Group.Provider, { value: onValueChange }, children),
    DropdownMenuRadioItem: function RadioItem({
      children,
      value,
    }: {
      children?: React.ReactNode
      value: string
    }) {
      const change = React.useContext(Group)
      return React.createElement(
        "button",
        {
          type: "button",
          role: "menuitemradio",
          "aria-checked": false,
          onClick: () => change(value),
        },
        children
      )
    },
  }
})

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

const copy = enChat.selection

/**
 * Put a real DOM selection over `node`'s text.
 *
 * jsdom implements Selection/Range well enough for the component's checks
 * (containment, collapsed, toString, intersectsNode). It has NO
 * `Range.getClientRects`, which the component guards for — throwing there would
 * abort a `selectionchange` listener over a button position.
 */
function selectText(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
}

/** A transcript with two message rows and one non-message element. */
function transcript() {
  const host = document.createElement("div")
  host.innerHTML = `
    <div data-msg-id="m1"><p>the question about caching</p></div>
    <div data-msg-id="m2"><p>keep the cache warm between deploys</p></div>
    <div data-testid="divider">unread messages below</div>
  `
  document.body.appendChild(host)
  const ref = createRef<HTMLElement>()
  ;(ref as { current: HTMLElement | null }).current = host
  const row = (id: string) => host.querySelector(`[data-msg-id="${id}"] p`)!
  return { host, ref, row }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRunState = { status: "idle" }
  mockCreate.mockResolvedValue({ id: "aside-1", title: "quoted" })
  mockBuildExcerpt.mockImplementation(async (input: { text: string }) => ({
    kind: "entity",
    entityKind: "message",
    entityId: "main-1#m2",
    title: input.text,
    snapshot: input.text,
    comment: "",
    capturedAt: 1,
    excerpt: { derivation: "quote", quote: input.text },
  }))
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ""
  act(() => useChatStore.getState().clear())
  useComposerIntentStore.setState({ pendingBySession: {} })
})

describe("useTranscriptSelection", () => {
  it("reports the selection and the message it was made in", () => {
    const { ref, row } = transcript()
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(row("m2")))
    expect(result.current).toMatchObject({
      text: "keep the cache warm between deploys",
      messageIds: ["m2"],
    })
    expect(result.current?.context).toContain("keep the cache warm between deploys")
  })

  it("names every message a selection runs across, in order", () => {
    const { host, ref, row } = transcript()
    const range = document.createRange()
    range.setStart(row("m1").firstChild!, 4)
    range.setEnd(row("m2").firstChild!, 8)
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => {
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    })
    expect(result.current?.messageIds).toEqual(["m1", "m2"])
    expect(messageRowsInRange(host, range).map((row) => row.dataset.msgId)).toEqual(["m1", "m2"])
  })

  it("ignores a selection outside the container", () => {
    const { ref } = transcript()
    const outside = document.createElement("div")
    outside.textContent = "the composer, not a message"
    document.body.appendChild(outside)
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(outside))
    expect(result.current).toBeNull()
  })

  it("ignores a selection too short to be deliberate", () => {
    const { host, ref } = transcript()
    host.textContent = "ok"
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(host))
    expect(result.current).toBeNull()
  })

  // The three-character floor refused everyday two-character CJK words.
  it("accepts a two-character CJK word", () => {
    const { host, ref } = transcript()
    host.textContent = "变量"
    const { result } = renderHook(() => useTranscriptSelection(ref))
    act(() => selectText(host))
    expect(result.current?.text).toBe("变量")
  })
})

describe("MessageSelectionToolbar", () => {
  function renderToolbar(props: { allowAside?: boolean } = {}) {
    const parts = transcript()
    const view = render(
      <MessageSelectionToolbar sessionId="main-1" containerRef={parts.ref} {...props} />
    )
    return { ...parts, ...view }
  }

  it("stays hidden until something is selected", () => {
    renderToolbar()
    expect(screen.queryByTestId("message-selection-toolbar")).not.toBeInTheDocument()
  })

  it("offers every action for a selection in a message", async () => {
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    const toolbar = await screen.findByRole("toolbar", { name: copy.toolbarLabel })
    for (const name of [copy.reference, copy.askInAside, copy.summarize, copy.explain]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
    expect(toolbar).toBeInTheDocument()
  })

  it("stages the selection as a chip in this conversation's composer", async () => {
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.reference }))

    await waitFor(() =>
      expect(mockBuildExcerpt).toHaveBeenCalledWith({
        sessionId: "main-1",
        messageIds: ["m2"],
        text: "keep the cache warm between deploys",
        excerpt: { derivation: "quote", quote: "keep the cache warm between deploys" },
      })
    )
    await waitFor(() =>
      expect(useChatStore.getState().sessions["main-1"]?.contextSelections).toHaveLength(1)
    )
    expect(toastSuccess).toHaveBeenCalled()
    expect(window.getSelection()?.isCollapsed).toBe(true)
  })

  it("says so when the reference could not be built", async () => {
    mockBuildExcerpt.mockResolvedValueOnce(null)
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.reference }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(copy.referenceError))
  })

  it("cannot reference text that is not in any message", async () => {
    const { host } = renderToolbar()
    act(() => selectText(host.querySelector('[data-testid="divider"]')!))
    expect(await screen.findByRole("button", { name: copy.reference })).toBeDisabled()
  })

  // The quote used to be dispatched as an event before the aside's composer
  // mounted, so it reached no one. It is now a pending intent the composer
  // consumes once it hydrates.
  it("opens an aside and stages the quote for its composer to pick up", async () => {
    act(() => useChatStore.setState({ activeSessionId: "main-1" }))
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.askInAside }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        { kind: "session", sessionId: "main-1" },
        "keep the cache warm between deploys"
      )
    )
    await waitFor(() =>
      expect(useComposerIntentStore.getState().pendingBySession["aside-1"]).toMatchObject({
        prompt: "> keep the cache warm between deploys\n\n",
      })
    )
    expect(setSessionOverride).toHaveBeenCalledWith(expect.any(String), "aside-1")
    expect(revealSidechat).toHaveBeenCalled()
  })

  it("does not bring the dock forward for a pane that is not focused", async () => {
    act(() => useChatStore.setState({ activeSessionId: "someone-else" }))
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.askInAside }))
    await waitFor(() => expect(setSessionOverride).toHaveBeenCalled())
    expect(revealSidechat).not.toHaveBeenCalled()
  })

  it("offers no aside inside an aside", async () => {
    const { row } = renderToolbar({ allowAside: false })
    act(() => selectText(row("m2")))
    await screen.findByRole("button", { name: copy.reference })
    expect(screen.queryByRole("button", { name: copy.askInAside })).toBeNull()
  })

  it.each([
    ["summarize", copy.summarize],
    ["explain", copy.explain],
  ] as const)("runs %s on the selection", async (action, name) => {
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name }))
    expect(mockRun).toHaveBeenCalledWith({
      action,
      quote: "keep the cache warm between deploys",
      sessionId: "main-1",
      messageIds: ["m2"],
      context: expect.stringContaining("keep the cache warm"),
    })
  })

  it("translates into the chosen language and remembers the choice", async () => {
    const { row } = renderToolbar()
    act(() => selectText(row("m2")))
    expect(await screen.findByRole("button", { name: copy.chooseLanguage })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitemradio", { name: enToolbar.languages.fr }))
    expect(mockSetPref).toHaveBeenCalledWith("selectionToolbar.translateLocale", "fr")
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ action: "translate", targetLocale: "fr" })
    )
  })

  it("stages a result under the text it was generated from, then closes the panel", async () => {
    const { row, rerender, ref } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.summarize }))
    const request = mockRun.mock.calls[0]![0]
    mockRunState = { status: "done", request, text: "Warm caches, briefly.", parts: 1 }
    rerender(<MessageSelectionToolbar sessionId="main-1" containerRef={ref} />)

    fireEvent.click(await screen.findByTestId("message-selection-result-reference"))
    await waitFor(() =>
      expect(mockBuildExcerpt).toHaveBeenCalledWith({
        sessionId: "main-1",
        messageIds: ["m2"],
        text: "Warm caches, briefly.",
        excerpt: { derivation: "summary", quote: "keep the cache warm between deploys" },
      })
    )
    await waitFor(() => expect(mockClose).toHaveBeenCalled())
  })

  it("keeps the capsule out of the way of its own answer", async () => {
    const { row, rerender, ref } = renderToolbar()
    act(() => selectText(row("m2")))
    fireEvent.click(await screen.findByRole("button", { name: copy.explain }))
    const request = mockRun.mock.calls[0]![0]
    mockRunState = { status: "running", request, text: "", progress: null }
    rerender(<MessageSelectionToolbar sessionId="main-1" containerRef={ref} />)
    await screen.findByTestId("message-selection-result")
    expect(screen.queryByRole("toolbar", { name: copy.toolbarLabel })).toBeNull()
  })
})
