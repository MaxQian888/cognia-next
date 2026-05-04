// Coverage for the data-hooks integration point in composer — the inner
// component now reads `useUpdateSession()` from the adapter and uses it to
// persist permissionMode changes back to the session row. This test mounts
// the full <Composer> with a stub adapter, then drives a permissionMode
// change through the chat-store and asserts the adapter mutation is called.

// Heavy file-system / shell / memory / slash-command modules pull in Tauri
// IPC and disk reads that have no place in a logic-level component test.
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
jest.mock("@/lib/files/memory", () => ({
  appendMemory: jest.fn(),
}))
jest.mock("./composer/screenshot-button", () => ({
  ScreenshotButton: () => null,
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))

import { render, waitFor } from "@testing-library/react"
import { act } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@/lib/claude/types"

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

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ComposerTestWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_42",
  title: "Composer Test Chat",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

beforeEach(() => {
  useChatStore.getState().clear()
})

describe("Composer — data-hooks integration", () => {
  it("renders without crashing when DataAdapterProvider is mounted", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    // The textarea is the source-of-truth element — composer is wired up.
    expect(document.querySelector("textarea")).not.toBeNull()
  })

  it("persists permissionMode changes via adapter.updateSession", async () => {
    const updateSession = jest.fn(async () => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <TooltipProvider>
          <Composer
            session={mkSession({ permissionMode: undefined })}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </TooltipProvider>
      </DataAdapterProvider>
    )

    // Drive a permissionMode change through the chat-store; the inner
    // composer's useEffect should detect the divergence from the session row
    // and route the mutation through the adapter.
    await act(async () => {
      useChatStore.getState().setPermissionMode("acceptEdits")
    })

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith("ses_42", {
        permissionMode: "acceptEdits",
      })
    })
  })

  it("does not re-fire updateSession when permissionMode already matches the session row", async () => {
    const updateSession = jest.fn(async () => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <TooltipProvider>
          <Composer
            session={mkSession({ permissionMode: "plan" })}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </TooltipProvider>
      </DataAdapterProvider>
    )

    // Hydrate the chat-store with the same value the session already carries.
    await act(async () => {
      useChatStore.getState().setPermissionMode("plan")
    })

    // No divergence ⇒ no write.
    await waitFor(() => {
      // Allow the microtask queue to settle then assert no call.
      return new Promise((r) => setTimeout(r, 30))
    })
    expect(updateSession).not.toHaveBeenCalled()
  })
})
