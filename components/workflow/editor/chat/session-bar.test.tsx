/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/messages", () => ({
  clearMessages: jest.fn(async () => undefined),
}))

jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
  deleteSession: jest.fn(async () => undefined),
  clearSessionSdkLink: jest.fn(async () => undefined),
}))

const sessionsPut = jest.fn(async () => undefined)
const sessionsWhere = jest.fn(() => ({
  startsWith: () => ({ toArray: async () => [] }),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: {
      put: sessionsPut,
      where: sessionsWhere,
    },
  }),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { clearMessages } from "@/lib/db/messages"
import { updateSession, deleteSession, clearSessionSdkLink } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { WorkflowSessionBar } from "./session-bar"

const mLive = useLiveQuery as jest.Mock
const mUpdate = updateSession as jest.Mock
const mDelete = deleteSession as jest.Mock
const mClearMessages = clearMessages as jest.Mock
const mClearSdk = clearSessionSdkLink as jest.Mock

const MESSAGES = {
  workflowEditor: {
    chat: {
      session: {
        switchLabel: "Switch session",
        placeholder: "Pick a session",
        new: "New session",
        rename: "Rename",
        defaultTag: "Default",
        delete: "Delete",
        deleteDefaultBlocked: "Cannot delete the default session.",
        created: "New session created",
        deleted: "Session deleted",
        newDefault: "Workflow chat",
        newSuffixed: "{name} — extra",
        handlerDefault: "Copilot",
        cleared: "Cleared",
      },
      clear: "Clear",
      clearConfirmTitle: "Clear conversation?",
      clearConfirmDescription: "Drops all messages.",
      clearCancel: "Cancel",
      clearConfirm: "Clear",
      rename: {
        title: "Rename session",
        description: "Pick a new name.",
        placeholder: "New name",
        cancel: "Cancel",
        save: "Save",
        empty: "Name cannot be empty",
        success: "Renamed",
      },
    },
  },
}

function harness(activeSessionId = "workflow:wf_a") {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never}>
      <WorkflowSessionBar
        workflowId="wf_a"
        workflowName="My Flow"
        activeSessionId={activeSessionId}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  sessionsPut.mockClear()
  // Default: only the default session row.
  mLive.mockReturnValue([
    {
      id: "workflow:wf_a",
      title: "My Flow — chat",
      kind: "workflow-editor",
      createdAt: 0,
      updatedAt: 1,
    },
  ])
  act(() => useChatStore.getState().setMessages([]))
})

describe("WorkflowSessionBar", () => {
  it("renders the active session title and the handler badge", () => {
    harness()
    expect(screen.getByTestId("workflow-session-switcher")).toHaveTextContent("My Flow — chat")
    expect(screen.getByTestId("workflow-handler-badge")).toBeInTheDocument()
  })

  it("creates a new session via the + button", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("workflow-session-new"))
    expect(sessionsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workflow-editor",
        id: expect.stringMatching(/^workflow:wf_a:/),
      })
    )
  })

  it("renames the active session", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("workflow-session-rename"))
    const input = await screen.findByTestId("workflow-session-rename-input")
    await user.clear(input)
    await user.type(input, "Investigation Thread")
    await user.click(screen.getByTestId("workflow-session-rename-confirm"))
    expect(mUpdate).toHaveBeenCalledWith("workflow:wf_a", { title: "Investigation Thread" })
  })

  it("clears the conversation via the trash button + confirm", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("workflow-session-clear"))
    await user.click(screen.getByTestId("workflow-session-clear-confirm"))
    expect(mClearMessages).toHaveBeenCalledWith("workflow:wf_a")
    expect(mClearSdk).toHaveBeenCalledWith("workflow:wf_a")
  })

  it("deletes a non-default session when chosen from the dropdown", async () => {
    const user = userEvent.setup()
    mLive.mockReturnValue([
      {
        id: "workflow:wf_a",
        title: "Default",
        kind: "workflow-editor",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "workflow:wf_a:branch",
        title: "Branch",
        kind: "workflow-editor",
        createdAt: 0,
        updatedAt: 1,
      },
    ])
    harness("workflow:wf_a:branch")
    await user.click(screen.getByTestId("workflow-session-switcher"))
    await user.click(screen.getByTestId("workflow-session-delete"))
    expect(mDelete).toHaveBeenCalledWith("workflow:wf_a:branch")
  })

  it("never offers a delete option when the default session is active", async () => {
    const user = userEvent.setup()
    harness("workflow:wf_a")
    await user.click(screen.getByTestId("workflow-session-switcher"))
    expect(screen.queryByTestId("workflow-session-delete")).toBeNull()
  })
})
