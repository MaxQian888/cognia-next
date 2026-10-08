import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({ useEffectiveCwd: jest.fn() }))
jest.mock("@/stores/chat/session-store", () => ({
  useSessionStore: (select: (state: { sessions: Array<{ id: string }> }) => unknown) =>
    select({ sessions: [{ id: "s1" }] }),
}))
jest.mock("@/lib/browser/local-content-client", () => ({ detectDevServers: jest.fn() }))
jest.mock("@/lib/browser/launch-config", () => {
  const actual = jest.requireActual("@/lib/browser/launch-config")
  return { ...actual, loadLaunchConfigs: jest.fn(), startLaunchConfiguration: jest.fn() }
})

import { toast } from "sonner"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import { loadLaunchConfigs, startLaunchConfiguration } from "@/lib/browser/launch-config"
import { detectDevServers } from "@/lib/browser/local-content-client"

import { BrowserLaunchConfigs } from "./browser-launch-configs"

const copy = en.browserVault.launch

const web = {
  name: "web",
  runtimeExecutable: "pnpm",
  runtimeArgs: ["dev"],
  port: 3000,
  url: null,
  cwd: null,
  env: {},
}
const docs = { ...web, name: "docs", runtimeArgs: ["docs:dev"], port: 3001 }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useEffectiveCwd).mockReturnValue("/repo")
  jest
    .mocked(detectDevServers)
    .mockResolvedValue([
      { url: "http://localhost:3001/", port: 3001, pid: null, process: null, title: null },
    ])
  jest.mocked(loadLaunchConfigs).mockResolvedValue({
    path: "/repo/.claude/launch.json",
    configurations: [web, docs],
    invalid: 1,
  })
})

it("renders nothing without a working directory", () => {
  jest.mocked(useEffectiveCwd).mockReturnValue(null)
  const { container } = render(<BrowserLaunchConfigs sessionId="s1" onOpen={jest.fn()} />)
  expect(container).toBeEmptyDOMElement()
  expect(loadLaunchConfigs).not.toHaveBeenCalled()
})

it("lists configurations with their command, port and running state", async () => {
  render(<BrowserLaunchConfigs sessionId="s1" onOpen={jest.fn()} />)
  const start = await screen.findByRole("button", { name: "Start web and open it" })
  expect(start).toHaveTextContent("pnpm dev")
  expect(start).toHaveTextContent(":3000")
  expect(screen.getByRole("button", { name: "Open docs" })).toHaveTextContent("Running on :3001")
  expect(screen.getByText(/skipped/)).toBeInTheDocument()
  expect(loadLaunchConfigs).toHaveBeenCalledWith("/repo")
})

it("starts a configuration and opens its page when ready", async () => {
  const user = userEvent.setup()
  const onOpen = jest.fn()
  jest
    .mocked(startLaunchConfiguration)
    .mockResolvedValue({ kind: "ready", url: "http://localhost:3000/" })
  render(<BrowserLaunchConfigs sessionId="s1" onOpen={onOpen} />)
  await user.click(await screen.findByRole("button", { name: "Start web and open it" }))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("http://localhost:3000/"))
  expect(startLaunchConfiguration).toHaveBeenCalledWith(
    expect.objectContaining({ config: web, root: "/repo", chatSessionId: "s1" })
  )
  expect(loadLaunchConfigs).toHaveBeenCalledTimes(2)
})

it("toasts timeouts, portless starts and failures", async () => {
  const user = userEvent.setup()
  jest
    .mocked(startLaunchConfiguration)
    .mockResolvedValueOnce({ kind: "timeout", port: 3000 })
    .mockResolvedValueOnce({ kind: "started" })
    .mockRejectedValueOnce(new Error("denied"))
  render(<BrowserLaunchConfigs sessionId="s1" onOpen={jest.fn()} />)
  const button = await screen.findByRole("button", { name: "Start web and open it" })
  await user.click(button)
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "web did not open port 3000 in time. Check its terminal tab."
    )
  )
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("web started in a terminal tab."))
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not start web: denied"))
})

it("shows the empty hint, a read failure, and reloads on refresh", async () => {
  const user = userEvent.setup()
  jest.mocked(loadLaunchConfigs).mockResolvedValueOnce(null)
  render(<BrowserLaunchConfigs sessionId="s1" onOpen={jest.fn()} />)
  expect(await screen.findByText(copy.empty)).toBeInTheDocument()
  jest.mocked(loadLaunchConfigs).mockRejectedValueOnce(new Error("ValueExpected at offset 0"))
  await user.click(screen.getByRole("button", { name: copy.refresh }))
  expect(
    await screen.findByText("Could not read launch.json: ValueExpected at offset 0")
  ).toBeInTheDocument()
})
