/**
 * @jest-environment jsdom
 */
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

type EventHandler = (payload: unknown) => void
let captured: EventHandler | null = null
const unlistenMock = jest.fn()
const onTauriEventMock = jest.fn((_event: string, handler: EventHandler) => {
  captured = handler
  return Promise.resolve(unlistenMock)
})
jest.mock("@/lib/tauri/events", () => ({
  TAURI_EVENTS: { appCloseRequested: "app://close-requested" },
  onTauriEvent: (...args: [string, EventHandler]) => onTauriEventMock(...args),
}))

const resolveCloseRequestMock = jest.fn().mockResolvedValue(undefined)
const setCloseBehaviorMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/close-behavior", () => ({
  resolveCloseRequest: (...a: unknown[]) => resolveCloseRequestMock(...a),
  setCloseBehavior: (...a: unknown[]) => setCloseBehaviorMock(...a),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { app: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

import { ExitConfirmationDialog } from "./exit-confirmation-dialog"

async function openDialog() {
  render(<ExitConfirmationDialog />)
  await waitFor(() => expect(onTauriEventMock).toHaveBeenCalled())
  await act(async () => {
    captured?.(undefined)
  })
  await screen.findByText("exitDialog.title")
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  captured = null
})

it("does not subscribe outside Tauri", () => {
  isTauriMock.mockReturnValue(false)
  render(<ExitConfirmationDialog />)
  expect(onTauriEventMock).not.toHaveBeenCalled()
})

it("opens on the close-requested event", async () => {
  await openDialog()
  expect(screen.getByText("exitDialog.description")).toBeInTheDocument()
})

it("minimizes to tray without persisting when remember is unchecked", async () => {
  await openDialog()
  fireEvent.click(screen.getByText("exitDialog.minimizeToTray"))
  await waitFor(() => expect(resolveCloseRequestMock).toHaveBeenCalledWith("minimize"))
  expect(setCloseBehaviorMock).not.toHaveBeenCalled()
})

it("quits without persisting when remember is unchecked", async () => {
  await openDialog()
  fireEvent.click(screen.getByText("exitDialog.quit"))
  await waitFor(() => expect(resolveCloseRequestMock).toHaveBeenCalledWith("quit"))
  expect(setCloseBehaviorMock).not.toHaveBeenCalled()
})

it("persists 'tray' when remember is checked before minimizing", async () => {
  await openDialog()
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByText("exitDialog.minimizeToTray"))
  await waitFor(() => expect(setCloseBehaviorMock).toHaveBeenCalledWith("tray"))
  expect(resolveCloseRequestMock).toHaveBeenCalledWith("minimize")
})

it("persists 'quit' when remember is checked before quitting", async () => {
  await openDialog()
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByText("exitDialog.quit"))
  await waitFor(() => expect(setCloseBehaviorMock).toHaveBeenCalledWith("quit"))
  expect(resolveCloseRequestMock).toHaveBeenCalledWith("quit")
})

it("cancels via the cancel button", async () => {
  await openDialog()
  fireEvent.click(screen.getByText("exitDialog.cancel"))
  await waitFor(() => expect(resolveCloseRequestMock).toHaveBeenCalledWith("cancel"))
})
