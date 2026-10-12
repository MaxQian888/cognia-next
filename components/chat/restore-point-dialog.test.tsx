/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const getTurnMock = jest.fn()
jest.mock("@/lib/code-adoption/persist", () => ({
  getCodeAdoptionTurnForMessage: (...args: unknown[]) => getTurnMock(...args),
}))

const getPatchMock = jest.fn()
const undoMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  getTaskPatchSet: (...args: unknown[]) => getPatchMock(...args),
  undoTaskWorkspace: (...args: unknown[]) => undoMock(...args),
}))

const flags = { checkpoint: false }
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: () => flags.checkpoint,
  subscribeToAgentExecutionFlags: () => () => undefined,
}))

import { RestorePointDialog } from "./restore-point-dialog"
import { makeSessionSlice, useChatStore } from "@/stores/chat"

function seed() {
  useChatStore.setState({
    sessions: {
      s1: {
        ...makeSessionSlice(),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "did it" }] },
          { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
          { id: "a2", role: "assistant", parts: [{ type: "text", text: "did more" }] },
        ],
      },
    },
  } as never)
}

function turn(messageId: string) {
  return {
    id: `t-${messageId}`,
    runId: 1,
    sessionId: "s1",
    taskWorkspaceRunId: `run:${messageId}`,
    assistantMessageId: messageId,
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: 1,
    totalAdded: 1,
    totalRemoved: 0,
    files: [{ path: `${messageId}.ts`, added: 1, removed: 0, isNew: false, hunks: [] }],
    truncated: false,
    measurement: "taskWorkspace",
  }
}

/** The file plan loads asynchronously; let it land before the test ends. */
async function planSettled() {
  await waitFor(() =>
    expect(screen.getByTestId("restore-point-files")).not.toHaveTextContent("files.loading")
  )
}

beforeEach(() => {
  seed()
  flags.checkpoint = false
  getTurnMock.mockReset().mockImplementation(async (_s: string, id: string) => turn(id))
  getPatchMock
    .mockReset()
    .mockImplementation(async (runId: string) => ({ runId, state: "applied", reversible: true }))
  undoMock.mockReset().mockResolvedValue({ state: "reverted", revision: 2, conflicts: [] })
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("RestorePointDialog", () => {
  it("routes each conversation choice to the row's own mechanism and closes", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onEdit = jest.fn()
    const onBranch = jest.fn()
    const onTruncate = jest.fn()
    render(
      <RestorePointDialog
        sessionId="s1"
        messageId="u1"
        open
        onOpenChange={onOpenChange}
        onEdit={onEdit}
        onBranch={onBranch}
        onTruncate={onTruncate}
      />
    )
    await user.click(screen.getByTestId("restore-point-edit"))
    await user.click(screen.getByTestId("restore-point-branch"))
    await user.click(screen.getByTestId("restore-point-truncate"))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onBranch).toHaveBeenCalledTimes(1)
    expect(onTruncate).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await planSettled()
  })

  it("undoes every later reply's file changes, newest first, after a confirmation", async () => {
    const user = userEvent.setup()
    render(<RestorePointDialog sessionId="s1" messageId="u1" open onOpenChange={jest.fn()} />)
    // Both later replies were looked up — the one directly after, and the next turn.
    await waitFor(() => expect(screen.getByTestId("restore-point-undo-files")).toBeEnabled())
    expect(getTurnMock.mock.calls.map(([, id]) => id)).toEqual(["a1", "a2"])
    expect(screen.getByTestId("restore-point-files")).toHaveTextContent(
      'files.undoable:{"files":2,"turns":2}'
    )
    await user.click(screen.getByTestId("restore-point-undo-files"))
    await user.click(await screen.findByTestId("restore-point-undo-confirm"))
    await waitFor(() => expect(undoMock).toHaveBeenCalledTimes(2))
    expect(undoMock.mock.calls.map(([id]) => id)).toEqual(["run:a2", "run:a1"])
    expect(toastSuccess).toHaveBeenCalledWith('files.restored:{"turns":2}')
  })

  it("only looks at replies after the chosen message", async () => {
    render(<RestorePointDialog sessionId="s1" messageId="u2" open onOpenChange={jest.fn()} />)
    await waitFor(() => expect(screen.getByTestId("restore-point-undo-files")).toBeEnabled())
    expect(getTurnMock.mock.calls.map(([, id]) => id)).toEqual(["a2"])
  })

  it("says why files cannot be restored instead of undoing part of them", async () => {
    getPatchMock.mockImplementation(async (runId: string) => ({
      runId,
      state: "applied",
      reversible: runId !== "run:a2",
    }))
    render(<RestorePointDialog sessionId="s1" messageId="u1" open onOpenChange={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId("restore-point-files")).toHaveTextContent(
        "files.blocked.irreversible"
      )
    )
    expect(screen.queryByTestId("restore-point-undo-files")).not.toBeInTheDocument()
  })

  it("says so when nothing changed after the message", async () => {
    getTurnMock.mockResolvedValue(undefined)
    render(<RestorePointDialog sessionId="s1" messageId="u1" open onOpenChange={jest.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId("restore-point-files")).toHaveTextContent("files.none")
    )
  })

  it("explains an unavailable SDK checkpoint, and offers it once it is on", async () => {
    const rewindFiles = jest.fn()
    const { rerender } = render(
      <RestorePointDialog
        sessionId="s1"
        messageId="u1"
        open
        onOpenChange={jest.fn()}
        checkpoint={{ eligible: false, rewindFiles }}
      />
    )
    expect(screen.getByTestId("restore-point-checkpoint")).toHaveTextContent(
      "files.checkpointSdkOnly"
    )
    rerender(
      <RestorePointDialog
        sessionId="s1"
        messageId="u1"
        open
        onOpenChange={jest.fn()}
        checkpoint={{ eligible: true, rewindFiles }}
      />
    )
    expect(screen.getByTestId("restore-point-checkpoint")).toHaveTextContent("files.checkpointOff")
    expect(screen.queryByTestId("checkpoint-action-button")).not.toBeInTheDocument()
    await planSettled()
  })

  it("shows the checkpoint rewind when the SDK records checkpoints", async () => {
    flags.checkpoint = true
    render(
      <RestorePointDialog
        sessionId="s1"
        messageId="u1"
        open
        onOpenChange={jest.fn()}
        checkpoint={{ eligible: true, rewindFiles: jest.fn() }}
      />
    )
    expect(screen.getByTestId("checkpoint-action-button")).toHaveTextContent(
      "files.checkpointAction"
    )
    await planSettled()
  })

  it("refuses to rewrite anything while a reply is still running", async () => {
    render(
      <RestorePointDialog
        sessionId="s1"
        messageId="u1"
        open
        busy
        onOpenChange={jest.fn()}
        onEdit={jest.fn()}
        onTruncate={jest.fn()}
      />
    )
    expect(screen.getByTestId("restore-point-busy")).toHaveTextContent("busy")
    expect(screen.getByTestId("restore-point-edit")).toBeDisabled()
    expect(screen.getByTestId("restore-point-truncate")).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId("restore-point-undo-files")).toBeDisabled())
  })
})
