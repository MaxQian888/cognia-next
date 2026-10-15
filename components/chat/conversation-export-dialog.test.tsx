/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown>, deps: unknown[]) => {
    const React = jest.requireActual<typeof import("react")>("react")
    const [value, setValue] = React.useState<unknown>()
    React.useEffect(() => {
      let cancelled = false
      void query().then((next) => {
        if (!cancelled) setValue(next)
      })
      return () => {
        cancelled = true
      }
      // The production hook uses these dependencies to subscribe to the selected id.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockGetSession(id) }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

jest.mock("next/dynamic", () => () => {
  function MockSingleExportDialog(props: {
    session: ChatSession
    open: boolean
    onOpenChange: (open: boolean) => void
  }) {
    return (
      <div data-testid="export-dialog" data-open={String(props.open)}>
        {props.session.title}
        <span>{props.session.systemPrompt}</span>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          close
        </button>
      </div>
    )
  }
  return MockSingleExportDialog
})

import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { ConversationExportDialog } from "./conversation-export-dialog"

const session = {
  id: "s1",
  title: "Standup",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
} as ChatSession

test("renders nothing until a row asks to export", () => {
  render(<ConversationExportDialog session={null} onClose={jest.fn()} />)
  expect(screen.queryByTestId("export-dialog")).toBeNull()
})

test("opens with the complete stored row and reports its close", async () => {
  mockGetSession.mockResolvedValue({ ...session, systemPrompt: "Encrypted configuration" })
  const onClose = jest.fn()
  render(<ConversationExportDialog session={session} onClose={onClose} />)
  await waitFor(() => expect(screen.getByTestId("export-dialog")).toHaveTextContent("Standup"))
  expect(screen.getByText("Encrypted configuration")).toBeInTheDocument()
  expect(screen.getByTestId("export-dialog")).toHaveAttribute("data-open", "true")
  fireEvent.click(screen.getByText("close"))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test("does not export a projection when its full row was deleted", async () => {
  mockGetSession.mockResolvedValue(undefined)
  const onClose = jest.fn()
  render(<ConversationExportDialog session={session} onClose={onClose} />)
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(screen.queryByTestId("export-dialog")).toBeNull()
})

test("discards a delayed full row from the previous Host with the same session ID", async () => {
  setActiveRuntimeTargetContext("acct_local", "host-a")
  let resolve!: (row: ChatSession) => void
  mockGetSession.mockReturnValueOnce(
    new Promise<ChatSession>((done) => {
      resolve = done
    })
  )
  const view = render(<ConversationExportDialog session={session} onClose={jest.fn()} />)
  mockGetSession.mockResolvedValue({ ...session, systemPrompt: "Host B" })
  act(() => setActiveRuntimeTargetContext("acct_local", "host-b"))
  await waitFor(() => expect(screen.getByText("Host B")).toBeInTheDocument())
  await act(async () => {
    resolve({ ...session, systemPrompt: "Host A" })
  })
  expect(screen.queryByText("Host A")).not.toBeInTheDocument()
  view.unmount()
  clearActiveRuntimeTargetContext()
})
