/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import {
  __resetVscodeWindowForTesting,
  reportProgress,
  startProgress,
} from "@/lib/plugin/vscode-shim/window-ui-store"

import {
  VscodeMessageDialog,
  VscodeMessageToast,
  VscodeOpenExternalDialog,
  VscodeOutputToast,
  VscodeProgressToast,
} from "./vscode-notices"

const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )

const request = {
  pluginId: "ext.a",
  severity: "warning" as const,
  message: "$(warning) Update available",
  detail: "Version 2",
  modal: false,
  items: [{ title: "Install" }, { title: "Later" }],
}

beforeEach(() => __resetVscodeWindowForTesting())

it("message toast: shows the message and answers with the item or a dismissal", async () => {
  const user = userEvent.setup()
  const onChoose = jest.fn()
  wrap(<VscodeMessageToast request={request} onChoose={onChoose} />)
  expect(screen.getByText("Update available")).toBeInTheDocument()
  expect(screen.getByText("Version 2")).toBeInTheDocument()
  expect(screen.getByLabelText("Warning")).toBeInTheDocument()
  expect(screen.getByText("From ext.a")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Later" }))
  await user.click(screen.getByRole("button", { name: "Close" }))
  expect(onChoose.mock.calls).toEqual([[1], [null]])
})

it("modal message: adds Cancel, and a close without a choice answers with the close affordance", async () => {
  const user = userEvent.setup()
  const settle = jest.fn()
  const onClose = jest.fn()
  const view = wrap(
    <VscodeMessageDialog
      modalId="m"
      onClose={onClose}
      args={{ request: { ...request, modal: true }, settle }}
    />
  )
  await user.click(screen.getByRole("button", { name: "Install" }))
  expect(settle).toHaveBeenCalledWith(0)
  expect(onClose).toHaveBeenCalled()
  view.unmount()
  expect(settle).toHaveBeenCalledTimes(1)

  const settleClose = jest.fn()
  const withClose = wrap(
    <VscodeMessageDialog
      modalId="m2"
      onClose={() => {}}
      args={{
        request: {
          ...request,
          modal: true,
          items: [{ title: "Keep" }, { title: "Discard", isCloseAffordance: true }],
        },
        settle: settleClose,
      }}
    />
  )
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  withClose.unmount()
  expect(settleClose).toHaveBeenCalledWith(1)
})

it("progress toast: live message, percentage and cancel", async () => {
  const user = userEvent.setup()
  const onCancel = jest.fn()
  startProgress({
    handle: "h",
    pluginId: "ext.a",
    location: "notification",
    title: "Indexing",
    cancellable: true,
  })
  wrap(<VscodeProgressToast handle="h" onCancel={onCancel} />)
  expect(screen.getByText("Working…")).toBeInTheDocument()
  act(() => reportProgress("h", { message: "file 3", increment: 30 }))
  expect(screen.getByText("file 3")).toBeInTheDocument()
  expect(screen.getByText("30%")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(onCancel).toHaveBeenCalled()
})

it("output toast offers the logs", async () => {
  const user = userEvent.setup()
  const onOpenLogs = jest.fn()
  wrap(
    <VscodeOutputToast
      pluginId="ext.a"
      channel="Server"
      onOpenLogs={onOpenLogs}
      onDismiss={() => {}}
    />
  )
  expect(screen.getByText("ext.a wrote to its Server output")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Open logs" }))
  expect(onOpenLogs).toHaveBeenCalled()
})

it("open-external question: opens, copies, or answers nothing when closed", async () => {
  const user = userEvent.setup()
  const url = "https://example.com/login?x=1"
  for (const [button, choice] of [
    ["Open", "open"],
    ["Copy link", "copy"],
    ["Cancel", null],
  ] as const) {
    const settle = jest.fn()
    const onClose = jest.fn()
    const view = wrap(
      <VscodeOpenExternalDialog
        modalId="m"
        onClose={onClose}
        args={{ pluginId: "ext.a", url, settle }}
      />
    )
    expect(screen.getByText("ext.a wants to open this link")).toBeInTheDocument()
    expect(screen.getByText(url)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: button }))
    view.unmount()
    expect(settle.mock.calls).toEqual([[choice]])
    expect(onClose).toHaveBeenCalled()
  }
  const settle = jest.fn()
  wrap(
    <VscodeOpenExternalDialog
      modalId="m"
      onClose={jest.fn()}
      args={{ pluginId: "ext.a", url, settle }}
    />
  ).unmount()
  expect(settle.mock.calls).toEqual([[null]])
})
