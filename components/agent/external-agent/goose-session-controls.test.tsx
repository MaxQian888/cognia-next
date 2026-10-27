/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { GooseChildSessionLink, GooseSessionInspector } from "./goose-session-controls"

let mockLink: unknown
const mockInspect = jest.fn()
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useExternalSessionLinkForSession: () => mockLink,
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ inspectGooseChild: mockInspect }),
}))
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-run-client", () => ({
  createRemoteSessionOperationsClient: () => ({ inspectGooseChild: mockInspect }),
}))
beforeEach(() => {
  mockLink = undefined
  mockInspect.mockReset()
})

function show(completed = false, busy = false) {
  const api = {
    listChildren: jest.fn(async () => ["child"]),
    inspect: jest.fn(async () => ({
      id: "child",
      parentId: "parent",
      title: "Task",
      completed,
      transcript: "<script>inert</script>",
    })),
    recoveryPrompt: jest.fn(async () => "Resume child through parent"),
  }
  const onPrompt = jest.fn(async () => undefined)
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GooseSessionInspector api={api} parentId="parent" busy={busy} onPrompt={onPrompt} />
    </NextIntlClientProvider>
  )
  return { api, onPrompt }
}

it("loads a read-only snapshot, manually refreshes and resumes only through the parent", async () => {
  const { api, onPrompt } = show()
  fireEvent.click(screen.getByRole("button", { name: en.externalAgent.goose.refreshChildren }))
  fireEvent.click(await screen.findByRole("button", { name: "View child" }))
  expect(await screen.findByLabelText(en.externalAgent.goose.transcript)).toHaveTextContent(
    "<script>inert</script>"
  )
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: en.externalAgent.goose.reloadProgress }))
  await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: en.externalAgent.goose.resumeChild })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole("button", { name: en.externalAgent.goose.resumeChild }))
  await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("Resume child through parent"))
  expect(api.recoveryPrompt).toHaveBeenCalledWith("parent", "child")
})

it.each([
  [true, false],
  [false, true],
])("prevents recovery for completed=%s busy=%s", async (completed, busy) => {
  show(completed, busy)
  fireEvent.click(screen.getByRole("button", { name: en.externalAgent.goose.refreshChildren }))
  fireEvent.click(await screen.findByRole("button", { name: "View child" }))
  expect(
    await screen.findByRole("button", { name: en.externalAgent.goose.resumeChild })
  ).toBeDisabled()
})

it("discards a pending child transcript when the owning chat target changes", async () => {
  let finish: ((value: unknown) => void) | undefined
  mockInspect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  mockLink = {
    agentId: "agent",
    sessionId: "parent",
    host: { configId: "agent", revision: "r1", lifecycleGeneration: 1 },
  }
  const view = () => (
    <NextIntlClientProvider locale="en" messages={en}>
      <GooseChildSessionLink
        chatSessionId="chat"
        child={{ runtime: "goose", parentSessionId: "parent", sessionId: "child", readOnly: true }}
      />
    </NextIntlClientProvider>
  )
  const rendered = render(view())
  fireEvent.click(screen.getByRole("button", { name: "View child" }))
  await waitFor(() => expect(mockInspect).toHaveBeenCalled())
  mockLink = {
    agentId: "agent",
    sessionId: "parent",
    host: { configId: "agent", revision: "r2", lifecycleGeneration: 1 },
  }
  rendered.rerender(view())
  await act(async () =>
    finish?.({
      id: "child",
      parentId: "parent",
      title: "Old",
      completed: false,
      transcript: "old transcript",
    })
  )
  expect(screen.queryByText("old transcript")).not.toBeInTheDocument()
})
