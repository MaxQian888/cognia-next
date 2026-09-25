// A command run from the home composer (no conversation yet) has nowhere to
// append its answer: the pre-session projection is never rendered by the
// empty state, so `/template-list` and every plugin reply used to vanish. The
// composer now surfaces a text result as a toast there, and keeps appending
// it to the transcript once a conversation exists.

// Submitting clears the per-session draft via Dexie — provide a real IndexedDB.
import "fake-indexeddb/auto"

const toastMessage = jest.fn()

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    message: (...args: unknown[]) => toastMessage(...args),
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
    loading: jest.fn(),
    promise: jest.fn(),
  }),
}))
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
jest.mock("@/lib/telemetry/events/track-event", () => ({ trackEvent: jest.fn(async () => true) }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { act, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { __resetSlashCommandsForTesting, registerSlashCommand } from "@/lib/slash-commands/registry"
import type { ChatSession } from "@cognia/agent-config-types"

function makeAdapter(): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  }
}

function renderComposer(session: ChatSession | null) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  return render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={jest.fn()}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
}

async function runCommand(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
  // First Enter confirms the popover pick, the second submits.
  fireEvent.keyDown(textarea, { key: "Enter" })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  fireEvent.keyDown(textarea, { key: "Enter" })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
}

beforeEach(() => {
  useChatStore.getState().clear()
  toastMessage.mockClear()
  __resetSlashCommandsForTesting()
  registerSlashCommand({
    id: "acme.list",
    name: "/acme-list",
    description: "List things",
    source: "plugin",
    pluginId: "acme",
    handler: () => ({ message: "- alpha\n- beta" }),
  })
})

afterEach(() => {
  __resetSlashCommandsForTesting()
})

describe("a command's text result", () => {
  it("shows as a toast on the home composer, where no transcript is rendered", async () => {
    renderComposer(null)
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await runCommand(ta, "/acme-list")

    expect(toastMessage).toHaveBeenCalledTimes(1)
    const { container } = render(toastMessage.mock.calls[0][0])
    expect(container.textContent).toBe("- alpha\n- beta")
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it("is appended to the conversation when there is one", async () => {
    renderComposer({
      id: "ses_home",
      title: "Chat",
      kind: "direct",
      permissionMode: undefined,
      createdAt: 0,
      updatedAt: 0,
      workingDir: "/tmp/work",
    })
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await runCommand(ta, "/acme-list")

    expect(toastMessage).not.toHaveBeenCalled()
    const messages = useChatStore.getState().sessions["ses_home"]?.messages ?? []
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      parts: [{ type: "text", text: "- alpha\n- beta" }],
    })
  })
})
