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

function renderComposer(onSendImpl: (...args: unknown[]) => Promise<void> = async () => undefined) {
  const onSend = jest.fn(onSendImpl)
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

  it("keeps Stop as the primary button once a follow-up is typed, and queues it from beside it", async () => {
    const { ta, onSend, onStop } = renderComposer()
    setStatus("streaming")
    await screen.findByRole("button", { name: "Stop" })

    fireEvent.change(ta, { target: { value: "also check the tests" } })

    const followUp = await screen.findByRole("button", { name: "Send as a follow-up" })
    expect(followUp).toBeEnabled()
    // Stop never gives up its slot to the typed text.
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()

    fireEvent.click(followUp)
    // Third argument is the template run this turn was written from — `null`
    // for a hand-typed turn with no parameterized template behind it.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("also check the tests", [], null))
    expect(onStop).not.toHaveBeenCalled()
  })

  it("drops the follow-up control once the queued follow-up clears the box", async () => {
    const { ta } = renderComposer()
    setStatus("streaming")

    fireEvent.change(ta, { target: { value: "queued" } })
    fireEvent.click(await screen.findByRole("button", { name: "Send as a follow-up" }))

    await waitFor(() => expect(ta.value).toBe(""))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Send as a follow-up" })).toBeNull()
    )
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled()
  })

  it("keeps Stop reachable while streaming when the box holds only whitespace", async () => {
    const { ta } = renderComposer()
    setStatus("streaming")

    fireEvent.change(ta, { target: { value: "   " } })
    const stop = await screen.findByRole("button", { name: "Stop" })
    expect(stop).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Send as a follow-up" })).toBeNull()
  })

  // An external agent's send stays pending for the WHOLE run. The single
  // in-flight flag used to hold the button on a spinner until the run ended:
  // no Stop at all, and every follow-up rejected by the re-entrancy guard.
  describe("when the dispatch stays pending for the whole run", () => {
    function renderLongRun() {
      let calls = 0
      let finishRun: () => void = () => undefined
      // The first send is the run; any later one is a follow-up, which the
      // controller queues and settles straight away.
      const view = renderComposer(
        () =>
          new Promise<void>((resolve) => {
            calls += 1
            if (calls === 1) finishRun = resolve
            else resolve()
          })
      )
      return { ...view, finishRun: () => finishRun() }
    }

    it("turns Send into Stop as soon as the run is live, interrupts on click, and sends again after", async () => {
      const { ta, onSend, onStop, finishRun } = renderLongRun()

      fireEvent.change(ta, { target: { value: "run the migration" } })
      fireEvent.click(await screen.findByRole("button", { name: "Send" }))
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
      // Dispatched, not yet live: the non-interactive spinner.
      expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled()

      setStatus("streaming")
      const stop = await screen.findByRole("button", { name: "Stop" })
      expect(stop).toBeEnabled()
      fireEvent.click(stop)
      expect(onStop).toHaveBeenCalledTimes(1)

      // The run settles: the store goes idle and the dispatch resolves.
      setStatus("idle")
      await act(async () => {
        finishRun()
        await Promise.resolve()
      })

      fireEvent.change(ta, { target: { value: "next question" } })
      const send = await screen.findByRole("button", { name: "Send" })
      await waitFor(() => expect(send).toBeEnabled())
      fireEvent.click(send)
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
      expect(onSend).toHaveBeenLastCalledWith("next question", [], null)
    })

    it("accepts a follow-up while the run's own dispatch is still pending", async () => {
      const { ta, onSend } = renderLongRun()

      fireEvent.change(ta, { target: { value: "run the migration" } })
      fireEvent.click(await screen.findByRole("button", { name: "Send" }))
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
      setStatus("streaming")
      await screen.findByRole("button", { name: "Stop" })

      fireEvent.change(ta, { target: { value: "skip the seed step" } })
      fireEvent.click(await screen.findByRole("button", { name: "Send as a follow-up" }))
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
      expect(onSend).toHaveBeenLastCalledWith("skip the seed step", [], null)
    })
  })
})
