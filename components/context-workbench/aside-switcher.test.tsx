/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { AsideSwitcher } from "./aside-switcher"

let asides: ChatSession[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    void fn
    return asides
  },
}))

const mockCreate = jest.fn()
const mockRename = jest.fn(async () => undefined)
const mockClear = jest.fn(async () => undefined)
const mockDelete = jest.fn(async () => undefined)
const mockPromote = jest.fn()
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  listResourceWorkbenchSessions: jest.fn(async () => []),
  createResourceWorkbenchSession: (...a: unknown[]) => mockCreate(...(a as [])),
  renameResourceWorkbenchSession: (...a: unknown[]) => mockRename(...(a as [])),
  clearResourceWorkbenchSession: (...a: unknown[]) => mockClear(...(a as [])),
  deleteResourceWorkbenchSession: (...a: unknown[]) => mockDelete(...(a as [])),
  promoteResourceWorkbenchSession: (...a: unknown[]) => mockPromote(...(a as [])),
}))

const openSession = jest.fn()
const setActiveSession = jest.fn()
const requestSessionMessagesReload = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({ openSession, setActiveSession, requestSessionMessagesReload }),
  },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const messages = {
  contextWorkbench: {
    asides: {
      actionError: "That didn't work.",
      cancel: "Cancel",
      clear: "Clear",
      clearBody: "Messages go, aside stays.",
      cleared: "Aside cleared.",
      clearTitle: "Clear this aside?",
      createError: "Couldn't create an aside.",
      defaultName: "Aside {n}",
      delete: "Delete",
      deleteBody: "This aside and its messages go.",
      deleted: "Aside deleted.",
      deleteTitle: "Delete this aside?",
      fallbackName: "Aside",
      listLabel: "Asides",
      moreAria: "Aside actions",
      newAria: "New aside",
      promote: "Promote to a conversation",
      promoted: "Promoted.",
      rename: "Rename",
      renameTitle: "Rename aside",
      save: "Save",
      nameLabel: "Aside name",
      switchAria: "Switch aside",
    },
  },
}

const binding: SessionSurfaceBinding = { kind: "session", sessionId: "main-1" }
const PRIMARY = "resource-workbench:session:main-1"

const aside = (id: string, title: string, createdAt: number): ChatSession =>
  ({
    id,
    title,
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    surfaceBindingKey: "session:main-1",
    createdAt,
    updatedAt: createdAt,
  }) as ChatSession

function renderSwitcher(activeId = PRIMARY, onSelect = jest.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AsideSwitcher
        binding={binding}
        activeId={activeId}
        primaryId={PRIMARY}
        onSelect={onSelect}
      />
    </NextIntlClientProvider>
  )
  return onSelect
}

beforeEach(() => {
  jest.clearAllMocks()
  asides = [aside(PRIMARY, "Aside", 1), aside("extra-1", "Check versions", 2)]
  mockCreate.mockResolvedValue(aside("extra-2", "Aside 3", 3))
  mockPromote.mockResolvedValue({ id: "extra-1", kind: "direct" })
})

describe("AsideSwitcher", () => {
  it("shows the active aside's name", () => {
    renderSwitcher("extra-1")
    expect(screen.getByLabelText("Switch aside")).toHaveTextContent("Check versions")
  })

  it("creates a named aside and selects it", async () => {
    const onSelect = renderSwitcher()
    await act(async () => {
      fireEvent.click(screen.getByLabelText("New aside"))
    })
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(binding, "Aside 3"))
    expect(onSelect).toHaveBeenCalledWith("extra-2")
  })

  it("falls back to a surviving aside when the active one disappears", async () => {
    // The rendered aside can be deleted from under the panel; showing an empty
    // thread with a dead label would be worse than re-pointing.
    const onSelect = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AsideSwitcher
          binding={binding}
          activeId="already-gone"
          primaryId={PRIMARY}
          onSelect={onSelect}
        />
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(PRIMARY))
  })

  it("promotes the active aside and brings it forward as a conversation", async () => {
    const user = userEvent.setup()
    renderSwitcher("extra-1")
    await user.click(screen.getByLabelText("Aside actions"))
    await user.click(await screen.findByText("Promote to a conversation"))
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith("extra-1"))
    // The point of promoting is that it stops being confined to the dock.
    expect(openSession).toHaveBeenCalledWith("extra-1")
    expect(setActiveSession).toHaveBeenCalledWith("extra-1")
  })

  it("withholds delete on the primary aside, which would only be re-created", async () => {
    const user = userEvent.setup()
    renderSwitcher(PRIMARY)
    await user.click(screen.getByLabelText("Aside actions"))
    const item = await screen.findByRole("menuitem", { name: "Delete" })
    expect(item).toHaveAttribute("aria-disabled", "true")
  })

  it("allows delete on an extra aside, behind a confirm", async () => {
    const user = userEvent.setup()
    renderSwitcher("extra-1")
    await user.click(screen.getByLabelText("Aside actions"))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    // Confirm dialog, not an immediate delete.
    expect(mockDelete).not.toHaveBeenCalled()
    expect(await screen.findByText("Delete this aside?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("extra-1"))
  })

  it("clears an aside and asks the panel to re-read from Dexie", async () => {
    const user = userEvent.setup()
    renderSwitcher("extra-1")
    await user.click(screen.getByLabelText("Aside actions"))
    await user.click(await screen.findByRole("menuitem", { name: "Clear" }))
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(mockClear).toHaveBeenCalledWith("extra-1"))
    expect(requestSessionMessagesReload).toHaveBeenCalledWith("extra-1")
  })

  it("renames through a dialog, refusing an empty name", async () => {
    // `pointerEventsCheck: 0` — this is the only action that opens a Radix
    // `Dialog` (the others open an `AlertDialog`). Dialog's scroll lock puts
    // `pointer-events: none` on body, and userEvent's default check then
    // refuses every subsequent click and the test hangs.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSwitcher("extra-1")
    await user.click(screen.getByLabelText("Aside actions"))
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const input = await screen.findByLabelText("Aside name")
    fireEvent.change(input, { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    fireEvent.change(input, { target: { value: "Dependency audit" } })
    // `fireEvent` for the plain button: Radix Dialog puts `pointer-events: none`
    // on body, which userEvent's pointer check refuses to click through. Only
    // the Radix *triggers* above genuinely need userEvent.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    await waitFor(() => expect(mockRename).toHaveBeenCalledWith("extra-1", "Dependency audit"))
  })
})
