import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn(), save: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/browser/local-content-client", () => ({
  detectDevServers: jest.fn(),
  serveLocalFile: jest.fn(),
  stopLocalFile: jest.fn(),
}))

import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { detectDevServers, serveLocalFile, stopLocalFile } from "@/lib/browser/local-content-client"

import { BrowserLocalContentPicker } from "./browser-local-content-picker"

const copy = en.browserVault.localContent

beforeEach(() => {
  jest.clearAllMocks()
  ;(detectDevServers as jest.Mock).mockResolvedValue([
    { url: "http://127.0.0.1:5173/", port: 5173, pid: 42, process: "node", title: "Vite App" },
    { url: "http://127.0.0.1:3000/", port: 3000, pid: null, process: null, title: null },
  ])
})

it("lists detected dev servers sorted by port and opens one", async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  render(<BrowserLocalContentPicker onOpen={onOpen} />)
  const buttons = await screen.findAllByRole("button", { name: /^Open http/ })
  expect(buttons.map((button) => button.textContent)).toEqual([
    "http://127.0.0.1:3000/Port 3000",
    "Vite AppPort 5173 · node",
  ])
  await user.click(screen.getByRole("button", { name: "Open http://127.0.0.1:5173/" }))
  expect(onOpen).toHaveBeenCalledWith("http://127.0.0.1:5173/")
})

it("shows the empty state and re-detects on refresh", async () => {
  const user = userEvent.setup()
  ;(detectDevServers as jest.Mock).mockResolvedValueOnce([])
  render(<BrowserLocalContentPicker onOpen={jest.fn()} />)
  expect(await screen.findByText(copy.devServersEmpty)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: en.browserVault.common.refresh }))
  expect(
    await screen.findByRole("button", { name: "Open http://127.0.0.1:3000/" })
  ).toBeInTheDocument()
  expect(detectDevServers).toHaveBeenCalledTimes(2)
})

it("reports a failed detection", async () => {
  ;(detectDevServers as jest.Mock).mockRejectedValue(new Error("lsof missing"))
  render(<BrowserLocalContentPicker onOpen={jest.fn()} />)
  expect(await screen.findByText(copy.devServersFailed)).toBeInTheDocument()
})

it("serves a picked file, opens its URL, and can stop sharing it", async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  ;(openDialog as jest.Mock).mockResolvedValue("/Users/me/site/index.html")
  ;(serveLocalFile as jest.Mock).mockResolvedValue({
    url: "http://127.0.0.1:61000/abc/index.html",
    root: "/Users/me/site",
  })
  ;(stopLocalFile as jest.Mock).mockResolvedValue(undefined)
  render(<BrowserLocalContentPicker onOpen={onOpen} />)
  await user.click(screen.getByRole("button", { name: copy.openFile }))
  await waitFor(() => expect(serveLocalFile).toHaveBeenCalledWith("/Users/me/site/index.html"))
  expect(openDialog).toHaveBeenCalledWith({ multiple: false, directory: false })
  expect(onOpen).toHaveBeenCalledWith("http://127.0.0.1:61000/abc/index.html")

  await user.click(screen.getByRole("button", { name: "/Users/me/site/index.html" }))
  expect(onOpen).toHaveBeenCalledTimes(2)

  await user.click(screen.getByRole("button", { name: copy.stop }))
  await waitFor(() => expect(stopLocalFile).toHaveBeenCalledWith("/Users/me/site"))
  expect(screen.queryByText(copy.served)).toBeNull()
})

it("serves a picked folder", async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  ;(openDialog as jest.Mock).mockResolvedValue("/Users/me/site")
  ;(serveLocalFile as jest.Mock).mockResolvedValue({
    url: "http://127.0.0.1:61000/abc/",
    root: "/Users/me/site",
  })
  render(<BrowserLocalContentPicker onOpen={onOpen} />)
  await user.click(screen.getByRole("button", { name: copy.openFolder }))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("http://127.0.0.1:61000/abc/"))
  expect(openDialog).toHaveBeenCalledWith({ multiple: false, directory: true })
})

it("does nothing when the picker is cancelled and reports serve failures", async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  ;(openDialog as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce("/bad")
  ;(serveLocalFile as jest.Mock).mockRejectedValue(new Error("denied"))
  render(<BrowserLocalContentPicker onOpen={onOpen} />)
  await user.click(screen.getByRole("button", { name: copy.openFile }))
  await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(1))
  expect(serveLocalFile).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: copy.openFile }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.serveFailed))
  expect(onOpen).not.toHaveBeenCalled()
})

it("reports a failed stop and keeps the entry", async () => {
  const user = userEvent.setup()
  ;(openDialog as jest.Mock).mockResolvedValue("/tmp/a")
  ;(serveLocalFile as jest.Mock).mockResolvedValue({ url: "http://127.0.0.1:1/x/", root: "/tmp/a" })
  ;(stopLocalFile as jest.Mock).mockRejectedValue(new Error("gone"))
  render(<BrowserLocalContentPicker onOpen={jest.fn()} />)
  await user.click(screen.getByRole("button", { name: copy.openFolder }))
  await user.click(await screen.findByRole("button", { name: copy.stop }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.stopFailed))
  expect(screen.getByText(copy.served)).toBeInTheDocument()
})
