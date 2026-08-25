/**
 * @jest-environment jsdom
 *
 * `{{parameter}}` chips in the composer: recognising them, filling them, and
 * getting them back after a reload.
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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { flushDebouncedDraftWrites, getDraft, setDraft } from "@/lib/db/chat-drafts"
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
  } as DataAdapter
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
}

const session: ChatSession = {
  id: "ses_params",
  title: "Params",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

async function mount() {
  const view = render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={async () => undefined}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  const ta = document.querySelector("textarea") as HTMLTextAreaElement
  // The draft hydration effect is async; let it settle so the persist effect
  // is armed before the test types anything.
  await act(async () => {
    await Promise.resolve()
  })
  return { ...view, ta }
}

/** Put the caret at `index` and release the pointer there, as a click would. */
function clickAt(ta: HTMLTextAreaElement, index: number) {
  ta.selectionStart = index
  ta.selectionEnd = index
  fireEvent.mouseUp(ta)
}

const chips = () => Array.from(document.querySelectorAll('[data-chip="param"]'))
/** The popover's field — `getByRole("textbox")` also matches the composer itself. */
const paramInput = () => within(screen.getByTestId("template-param-popover")).getByRole("textbox")

beforeEach(async () => {
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // Dexie teardown/rebuild routinely runs past Jest's 5s default under load.
}, 30_000)

describe("Composer — {{parameter}} chips", () => {
  it("paints a typed parameter as an empty chip", async () => {
    const { ta } = await mount()

    fireEvent.change(ta, { target: { value: "review {{module}} please" } })

    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toHaveAttribute("data-param-state", "empty")
    expect(chips()[0].textContent).toBe("{{module}}")
  })

  it("opens the editor on a click inside the token, and fills the chip", async () => {
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })

    clickAt(ta, 10)

    expect(screen.getByTestId("template-param-popover")).toBeInTheDocument()
    fireEvent.change(paramInput(), { target: { value: "login" } })

    await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
  })

  it("does not open the editor when the caret merely passes through", async () => {
    // `onSelect` fires for arrow keys too. A panel that appeared every time the
    // caret drifted through a token would flash at someone reading back their
    // own sentence.
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })

    ta.selectionStart = 10
    ta.selectionEnd = 10
    fireEvent.select(ta)

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("keeps the value across a reload, reading the tokens back out of the text", async () => {
    const { ta, unmount } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })
    clickAt(ta, 10)
    fireEvent.change(paramInput(), { target: { value: "login" } })

    await act(async () => {
      await flushDebouncedDraftWrites()
    })
    await waitFor(async () =>
      expect(await getDraft(session.id)).toMatchObject({
        text: "review {{module}}",
        templateBinding: { params: { module: { kind: "text", value: "login" } } },
      })
    )

    unmount()
    await mount()

    await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
  })

  it("drops a value when its token is broken, so retyping it starts clean", async () => {
    await setDraft(session.id, "review {{module}}", [], {
      templateBinding: {
        templateId: "",
        version: "",
        params: { module: { kind: "text", value: "login" } },
        insertedAt: 1,
      },
    })
    const { ta } = await mount()
    await waitFor(() => expect(ta.value).toBe("review {{module}}"))

    fireEvent.change(ta, { target: { value: "review {{modul" } })

    expect(chips()).toHaveLength(0)
    await act(async () => {
      await flushDebouncedDraftWrites()
    })
    await waitFor(async () => {
      const row = await getDraft(session.id)
      expect(row?.templateBinding?.params).toEqual({})
    })
  })

  it("steps Tab from one parameter to the next", async () => {
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "{{a}} and {{b}}" } })
    ta.selectionStart = 0
    ta.selectionEnd = 0

    fireEvent.keyDown(ta, { key: "Tab" })

    expect(ta.selectionStart).toBe(10)
    expect(screen.getByTestId("template-param-popover")).toBeInTheDocument()
  })

  it("leaves Tab alone when the text has no parameters", async () => {
    // Tab is the only way a keyboard user gets out of the composer to the
    // toolbar; claiming it unconditionally would strand them.
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "just prose" } })

    const event = fireEvent.keyDown(ta, { key: "Tab" })

    expect(event).toBe(true) // not preventDefault-ed
  })
})
