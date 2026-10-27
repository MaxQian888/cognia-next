/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/automation.json"
import { SandboxDesktopViewer } from "@/components/settings/automation/sandbox-desktop-viewer"
import { sandboxClient } from "@/lib/automation/sandbox-client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

jest.mock("@/lib/automation/sandbox-client", () => ({
  isSandboxStreamUnavailable: (error: unknown) =>
    String(error).includes("sandbox_stream_unavailable"),
  sandboxClient: {
    desktopFrame: jest.fn(),
    acquireControl: jest.fn(),
    renewControl: jest.fn(),
    releaseControl: jest.fn(),
    controlInput: jest.fn(),
    streamOpen: jest.fn(),
    streamClaim: jest.fn(),
    streamClose: jest.fn(),
  },
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isCapacitor: () => false,
}))
jest.mock("@/components/settings/automation/sandbox-file-transfer", () => ({
  SandboxFileTransfer: () => null,
}))

const client = jest.mocked(sandboxClient)
let fence = 1
let sequence = 0
let viewers = 0

async function tick(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ automation: messages }}>
      <SandboxDesktopViewer connectionId="diagnostic" enabled />
    </NextIntlClientProvider>
  )
}

async function confirmHealthy() {
  const iframe = screen.getByTitle("Live sandbox desktop stream") as HTMLIFrameElement
  const target = iframe.contentWindow!
  const post = jest.spyOn(target, "postMessage")
  fireEvent.load(iframe)
  const hello = post.mock.calls.at(-1)![0] as { nonce: string }
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: target,
        origin: "http://127.0.0.1:49000",
        data: {
          type: "cognia-sandbox-stream-health",
          version: 1,
          nonce: hello.nonce,
          connected: true,
          presented: true,
          failed: null,
        },
      })
    )
  })
  post.mockRestore()
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.resetAllMocks()
  fence = 1
  sequence = 0
  viewers = 0
  client.desktopFrame.mockImplementation(async () => ({
    screenshot: { bytes: "aA==", width: 800, height: 600, capturedAt: Date.now(), format: "png" },
    frameId: `frame-${++sequence}`,
    fence,
    expiresAt: Date.now() + 5000,
  }))
  client.acquireControl.mockImplementation(async () => ({
    token: "fixture-lease",
    fence: ++fence,
    expiresAt: Date.now() + 15000,
  }))
  client.renewControl.mockImplementation(async () => ({
    token: "fixture-lease",
    fence,
    expiresAt: Date.now() + 15000,
  }))
  client.releaseControl.mockResolvedValue(undefined)
  client.streamClose.mockResolvedValue(undefined)
  client.controlInput.mockResolvedValue(undefined)
  client.streamOpen.mockImplementation(async () => ({
    viewerId: `viewer-${++viewers}`,
    url: `http://127.0.0.1:49000/?fixture=viewer-${viewers}`,
    role: "viewer",
    healthVersion: 1,
  }))
  client.streamClaim.mockImplementation(async (_connection, viewerId) => ({
    viewerId,
    url: "http://127.0.0.1:49000/?fixture=controller",
    role: "controller",
    healthVersion: 1,
  }))
})

afterEach(() => {
  jest.useRealTimers()
})

test("an iframe error falls back to screenshots and retries with a new view-only grant", async () => {
  mount()
  await tick()
  const iframe = screen.getByTitle("Live sandbox desktop stream")
  fireEvent.error(iframe)
  await tick()
  expect(screen.queryByTitle("Live sandbox desktop stream")).toBeNull()
  expect(screen.getByRole("img")).toBeInTheDocument()
  await tick(2000)
  expect(screen.getByTitle("Live sandbox desktop stream")).not.toBe(iframe)
  expect(screen.getByTitle("Live sandbox desktop stream")).toHaveAttribute(
    "data-stream-role",
    "viewer"
  )
  expect(client.streamOpen).toHaveBeenCalledTimes(2)
  expect(client.acquireControl).not.toHaveBeenCalled()
})

test("an auxiliary screenshot failure keeps the streaming lease and iframe", async () => {
  mount()
  await tick()
  await confirmHealthy()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Take control" }))
  })
  await tick()
  expect(screen.getByRole("status")).toHaveTextContent("You have control")
  const controlledIframe = screen.getByTitle("Live sandbox desktop stream")
  expect(controlledIframe).toHaveAttribute("data-stream-role", "controller")
  client.desktopFrame.mockRejectedValueOnce(
    new Error("injected screenshot failure while media is independent")
  )
  await tick(5000)
  expect(client.releaseControl).not.toHaveBeenCalled()
  expect(client.streamOpen).toHaveBeenCalledTimes(1)
  expect(client.streamClose).not.toHaveBeenCalled()
  expect(screen.getByTitle("Live sandbox desktop stream")).toBe(controlledIframe)
  expect(screen.getByRole("status")).toHaveTextContent("You have control")
  expect(client.renewControl).toHaveBeenCalled()
})

test("the actual guest bridge establishes media health and triggers view-only recovery", async () => {
  mount()
  await tick()
  const iframe = screen.getByTitle("Live sandbox desktop stream") as HTMLIFrameElement
  const target = iframe.contentWindow!
  const handlers = new Map<string, ((event?: unknown) => void)[]>()
  const parent = {
    postMessage(data: unknown, origin: string) {
      expect(origin).toBe(window.location.origin)
      window.dispatchEvent(
        new MessageEvent("message", {
          source: target,
          origin: "http://127.0.0.1:49000",
          data,
        })
      )
    },
  }
  const source = readFileSync(
    join(process.cwd(), "crates/cognia-automation/src/cua_sandbox/image/selkies/stream-health.js"),
    "utf8"
  )
  const timers: ReturnType<typeof setInterval>[] = []
  runInNewContext(source, {
    window: {
      parent,
      addEventListener(type: string, callback: (event?: unknown) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), callback])
      },
    },
    document: { hidden: false, addEventListener: jest.fn() },
    performance: { now: () => Date.now() },
    setInterval(callback: () => void, ms: number) {
      const timer = setInterval(callback, ms)
      timers.push(timer)
      return timer
    },
  })
  const post = jest.spyOn(target, "postMessage").mockImplementation((data, origin) => {
    expect(origin).toBe("http://127.0.0.1:49000")
    handlers
      .get("message")
      ?.forEach((callback) => callback({ source: parent, origin: window.location.origin, data }))
  })
  try {
    await act(async () => {
      fireEvent.load(iframe)
      handlers.get("cognia-selkies-connected")?.forEach((callback) => callback())
      handlers.get("cognia-selkies-output")?.forEach((callback) => callback())
    })
    expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled()
    await tick(30_000)
    expect(client.streamOpen).toHaveBeenCalledTimes(1)
    await act(async () => {
      handlers.get("cognia-selkies-error")?.forEach((callback) => callback())
    })
    await tick()
    expect(screen.queryByTitle("Live sandbox desktop stream")).toBeNull()
    await tick(2_000)
    expect(client.streamOpen).toHaveBeenCalledTimes(2)
    expect(screen.getByTitle("Live sandbox desktop stream")).toHaveAttribute(
      "data-stream-role",
      "viewer"
    )
    expect(client.acquireControl).not.toHaveBeenCalled()
  } finally {
    timers.forEach(clearInterval)
    post.mockRestore()
  }
})
