/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

const transportCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => ({ baseUrl: "https://cloud.example.com" }),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  buildTimeServerUrl: () => null,
}))
jest.mock("@/lib/db/browser-profiles", () => ({
  listBrowserDomainGrants: () => Promise.resolve([{ domain: "example.com" }]),
  listBrowserProfiles: () => Promise.resolve([]),
  touchBrowserProfile: jest.fn().mockResolvedValue(undefined),
}))

const navigate = jest.fn().mockResolvedValue(undefined)
const activatePage = jest.fn().mockResolvedValue(undefined)
const closePage = jest.fn().mockResolvedValue(undefined)
const listPages = jest
  .fn()
  .mockResolvedValue([{ id: "page-1", url: "https://example.com", title: "Example", active: true }])
jest.mock("@/lib/browser/remote-chromium-engine", () => ({
  RemoteChromiumEngine: jest.fn().mockImplementation(() => ({
    navigate,
    activatePage,
    closePage,
    listPages,
  })),
}))

import type { RemoteBrowserStreamOptions } from "@/lib/browser/remote-stream"
import { RemoteBrowserPreview } from "./remote-browser-preview"

let streamOptions: RemoteBrowserStreamOptions | null = null
const takeover = jest.fn()
const sendInput = jest.fn(() => true)
const connect = jest.fn().mockResolvedValue(undefined)
const close = jest.fn()
const createStream = (options: RemoteBrowserStreamOptions) => {
  streamOptions = options
  return { connect, close, takeover, sendInput }
}

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: jest.fn(), clearRect: jest.fn() }),
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  streamOptions = null
  transportCall.mockImplementation((name: string) => {
    if (name === "browser_capability") {
      return Promise.resolve({ capabilities: ["browser"] })
    }
    if (name === "browser_session_ensure") {
      return Promise.resolve({
        id: "browser-1",
        state: "ready",
        pages: [{ id: "page-1", url: "about:blank", title: "", active: true }],
        activePageId: "page-1",
      })
    }
    if (name === "browser_stream_ticket_issue") {
      return Promise.resolve({ ticket: "once", expiresAt: Date.now() + 60_000 })
    }
    return Promise.resolve(undefined)
  })
})

it("ensures a user-gated session and connects through a one-time ticket", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      parentChatSessionId="parent-1"
      workspaceId="workspace-1"
      initialUrl="https://example.com"
      createStream={createStream}
    />
  )

  await waitFor(() => expect(connect).toHaveBeenCalled())
  expect(transportCall).toHaveBeenCalledWith("browser_session_ensure", {
    chatSessionId: "chat-1",
    parentChatSessionId: "parent-1",
    workspaceId: "workspace-1",
    backendPreference: "remote-chromium",
    userEnabled: true,
    domainGrants: ["example.com"],
  })
  expect(navigate).toHaveBeenCalledWith("https://example.com")
})

it("takes human control before forwarding pointer input", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() => expect(connect).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "browser.remote.takeover" }))
  expect(takeover).toHaveBeenCalled()

  act(() => {
    streamOptions?.onLease?.({ epoch: 3, controller: { kind: "human", id: "device-1" } })
  })
  const canvas = screen.getByRole("application", { name: "browser.remote.canvas" })
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  })
  fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0 })
  expect(sendInput).toHaveBeenCalledWith({
    kind: "mouse",
    payload: expect.objectContaining({ type: "mousePressed", button: "left" }),
  })
})

it("automatically binds a team child session to its parent browser", async () => {
  render(
    <RemoteBrowserPreview
      chatSessionId="team-1::char::designer::turn-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await waitFor(() =>
    expect(transportCall).toHaveBeenCalledWith(
      "browser_session_ensure",
      expect.objectContaining({
        chatSessionId: "team-1::char::designer::turn-1",
        parentChatSessionId: "team-1",
      })
    )
  )
})

it("switches and closes pages through the host-neutral engine", async () => {
  listPages.mockResolvedValueOnce([
    { id: "page-1", url: "https://example.com", title: "Example", active: true },
    { id: "page-2", url: "https://example.com/two", title: "Two", active: false },
  ])
  render(
    <RemoteBrowserPreview
      chatSessionId="chat-1"
      workspaceId="workspace-1"
      createStream={createStream}
    />
  )
  await screen.findByRole("button", { name: "Two" })
  fireEvent.click(screen.getByRole("button", { name: "Two" }))
  await waitFor(() => expect(activatePage).toHaveBeenCalledWith("page-2"))
  fireEvent.click(screen.getAllByRole("button", { name: "browser.remote.closePage" })[1])
  await waitFor(() => expect(closePage).toHaveBeenCalled())
})
