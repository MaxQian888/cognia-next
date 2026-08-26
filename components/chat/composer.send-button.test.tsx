/**
 * @jest-environment jsdom
 *
 * The composer's primary button, rendered for real.
 *
 * `composer/send-button-mode.test.ts` pins the decision table; this pins the
 * wiring — that the resolved mode actually reaches the DOM (label, enabled
 * state, click target) once the store flips to `streaming`. The regression it
 * guards: a live turn used to force Stop even with a message typed, stranding
 * the follow-up the steer lane exists to accept.
 */

import "fake-indexeddb/auto"

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
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  ...jest.requireActual("@/lib/chat/attachments/dispatch"),
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  })),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore, type ChatStatus } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { ChatSession } from "@cognia/agent-config-types"

const adapter: DataAdapter = {
  useCharacters: () => undefined,
  useCharacter: () => undefined,
  useSkillsByIds: () => undefined,
  usePresets: () => undefined,
  clearMessages: jest.fn(async () => undefined),
  updateSession: jest.fn(async () => undefined),
  recordPresetUsage: jest.fn(async () => undefined),
  trustWorkspace: jest.fn(async () => undefined),
}

const Wrapper = ({ children }: { children: ReactNode }) => (
  <DataAdapterProvider adapter={adapter}>
    <TooltipProvider>{children}</TooltipProvider>
  </DataAdapterProvider>
)
Wrapper.displayName = "SendButtonWrapper"

const session: ChatSession = {
  id: "ses_send_button",
  title: "Send button",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
}

function renderComposer() {
  const onSend = jest.fn(async () => undefined)
  const onStop = jest.fn(async () => undefined)
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={onStop}
      />
    </Wrapper>
  )
  return {
    ta: document.querySelector("textarea") as HTMLTextAreaElement,
    onSend,
    onStop,
  }
}

/** Flip the focused session's status the way a real turn would. */
function setStatus(status: ChatStatus): void {
  act(() => {
    useChatStore.setState({ status })
  })
}

// The first full Composer mount in the test body costs as much as the cold-open
// hook under parallel workers and overruns the 5s default the same way, so the
// file gets the same 30s budget.
jest.setTimeout(30_000)

// Cold-open Dexie can exceed the default 5s hook budget on the first test.
beforeEach(async () => {
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

afterEach(() => {
  useSettingsStore.setState({ settings: undefined as never })
})

describe("composer primary button", () => {
  it("is a disabled Send when idle and empty, and enables once text is typed", async () => {
    const { ta } = renderComposer()

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()

    fireEvent.change(ta, { target: { value: "hello" } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled())
  })

  it("shows Stop while a turn streams with an empty box, and stops on click", async () => {
    const { onStop } = renderComposer()
    setStatus("streaming")

    const stop = await screen.findByRole("button", { name: "Stop" })
    expect(stop).toBeEnabled()
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalled()
  })

  it("switches back to Send while streaming as soon as a follow-up is typed", async () => {
    const { ta, onSend, onStop } = renderComposer()
    setStatus("streaming")
    await screen.findByRole("button", { name: "Stop" })

    fireEvent.change(ta, { target: { value: "also check the tests" } })

    const send = await screen.findByRole("button", { name: "Send as a follow-up" })
    expect(send).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()

    fireEvent.click(send)
    // Third argument is the template run this turn was written from — `null`
    // for a hand-typed turn with no parameterized template behind it.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("also check the tests", [], null))
    expect(onStop).not.toHaveBeenCalled()
  })

  it("returns to Stop once the queued follow-up clears the box", async () => {
    const { ta } = renderComposer()
    setStatus("streaming")

    fireEvent.change(ta, { target: { value: "queued" } })
    const send = await screen.findByRole("button", { name: "Send as a follow-up" })
    fireEvent.click(send)

    await waitFor(() => expect(ta.value).toBe(""))
    await screen.findByRole("button", { name: "Stop" })
  })

  it("keeps Stop reachable while streaming when the box holds only whitespace", async () => {
    const { ta } = renderComposer()
    setStatus("streaming")

    fireEvent.change(ta, { target: { value: "   " } })
    const stop = await screen.findByRole("button", { name: "Stop" })
    expect(stop).toBeEnabled()
  })
})
