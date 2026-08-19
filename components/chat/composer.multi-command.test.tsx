// End-to-end coverage for submit-time multi-command dispatch: a single message
// may contain several line-start `/commands` interleaved with prose. Action
// commands run (and send nothing on their own); template/free-text becomes the
// outgoing turn. Mirrors the unit coverage in lib/slash-commands/{parse,run}-
// segments but proves the composer wiring (textarea → submit → onSend).

// Submitting clears the per-session draft via Dexie — provide a real IndexedDB.
import "fake-indexeddb/auto"

const trackEvent = jest.fn(async () => true)

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...(args as [])),
}))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SendContent } from "@cognia/agent-config-types"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function renderComposer(onSend: (c: SendContent) => void, adapter = makeAdapter()) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  const session: ChatSession = {
    id: "ses_mc",
    title: "Multi-command",
    kind: "direct",
    permissionMode: undefined,
    createdAt: 0,
    updatedAt: 0,
    workingDir: "/tmp/work",
  }
  return render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
}

async function typeAndSubmit(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
  fireEvent.keyDown(textarea, { key: "Enter" })
  // Flush the async submit pipeline (parse → dispatch → onSend).
  await new Promise((r) => setTimeout(r, 50))
}

const textOf = (c: SendContent): string =>
  Array.isArray(c)
    ? c.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("")
    : typeof c === "string"
      ? c
      : ((c as { text?: string }).text ?? JSON.stringify(c))

beforeEach(() => {
  useChatStore.getState().clear()
  trackEvent.mockClear()
})

describe("Composer — multi-command submit", () => {
  it("strips an action command and sends only the trailing prose", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await typeAndSubmit(ta, "/help\nhello world")

    expect(onSend).toHaveBeenCalledTimes(1)
    const sent = textOf(onSend.mock.calls[0][0])
    expect(sent).toContain("hello world")
    expect(sent).not.toContain("/help")
  })

  it("does not send a turn for an action-only message", async () => {
    const onSend = jest.fn()
    const clearMessages = jest.fn(async () => undefined)
    renderComposer(onSend, makeAdapter({ clearMessages }))
    const ta = document.querySelector("textarea") as HTMLTextAreaElement

    // Typing "/clear" opens the slash popover. The first Enter CONFIRMS the
    // pick and drops "/clear " into the box (deferred-execution UX) — it must
    // not run the command or send a turn yet.
    fireEvent.change(ta, { target: { value: "/clear" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 0))
    expect(ta.value).toContain("/clear")
    expect(onSend).not.toHaveBeenCalled()
    expect(clearMessages).not.toHaveBeenCalled()

    // The popover is now dismissed; a second Enter submits. /clear is an action
    // command → mutates state, clears the box, sends nothing.
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 50))
    expect(ta.value).toBe("")
    expect(onSend).not.toHaveBeenCalled()
    // The command name is a registered identifier; its argument string is not
    // reported at all.
    expect(trackEvent).toHaveBeenCalledWith("app.command.executed", {
      command: "clear",
      kind: "action",
      outcome: "succeeded",
    })
  })

  it("leaves a plain prose message untouched (no command)", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await typeAndSubmit(ta, "just a normal sentence")

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(textOf(onSend.mock.calls[0][0])).toContain("just a normal sentence")
  })

  it("recalls the last sent message with ArrowUp from an empty input", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await typeAndSubmit(ta, "remember me")
    // After send the input is cleared; caret is at the start.
    expect(ta.value).toBe("")
    ta.setSelectionRange(0, 0)
    fireEvent.keyDown(ta, { key: "ArrowUp" })
    await new Promise((r) => setTimeout(r, 50))
    expect(ta.value).toBe("remember me")
  })
})
