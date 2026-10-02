jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
  Line: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { renderToString } from "react-dom/server"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { createStatusFixture, FIXTURE_ACTIVE_INCIDENT, FIXTURE_NOW_MS } from "@/lib/status/fixtures"
import { STATUS_RUNTIME_META_NAME, type PublicStatusSnapshot } from "@/lib/status/public-status"
import { openExternal } from "@/lib/tauri/opener"

import { PublicStatusPage } from "./public-status-page"

const fetchMock = jest.fn()
const TOKEN = "z".repeat(40)

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function setMeta(content: string | null) {
  document.head
    .querySelectorAll(`meta[name="${STATUS_RUNTIME_META_NAME}"]`)
    .forEach((node) => node.remove())
  if (content === null) return
  const meta = document.createElement("meta")
  meta.name = STATUS_RUNTIME_META_NAME
  meta.content = content
  document.head.appendChild(meta)
}

function serve(snapshot: PublicStatusSnapshot | (() => unknown)) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/snapshot")) {
      return typeof snapshot === "function" ? snapshot() : respond(200, snapshot)
    }
    if (url.includes(`/incidents/${FIXTURE_ACTIVE_INCIDENT.id}`)) {
      return respond(200, {
        schemaVersion: 1,
        incident: { ...FIXTURE_ACTIVE_INCIDENT, updates: [FIXTURE_ACTIVE_INCIDENT.latestUpdate] },
      })
    }
    if (url.includes("/incidents/")) return respond(404, { code: "not_found", requestId: "r" })
    throw new Error(`unexpected request ${url}`)
  })
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers({ now: FIXTURE_NOW_MS })
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
  window.history.replaceState(null, "", "/status/")
  setMeta(JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" }))
})

afterEach(() => {
  jest.useRealTimers()
  setMeta(null)
})

describe("PublicStatusPage", () => {
  it("prerenders only chrome and placeholders, never a status", () => {
    const html = renderToString(<PublicStatusPage />)
    expect(html).toContain("status-skeleton")
    expect(html).not.toContain("overall-status")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders the validated live snapshot: hero, components, incidents, maintenance, monitoring and footer", async () => {
    serve(createStatusFixture("major_outage", "90d"))
    render(<PublicStatusPage />)
    expect(screen.getByTestId("hero-skeleton")).toBeInTheDocument()
    await flush()

    expect(fetchMock.mock.calls[0][0]).toBe("/api/status/v1/snapshot?range=90d")
    expect(screen.getByTestId("overall-status")).toHaveTextContent("Major outage")
    expect(screen.getByRole("heading", { name: "Signaling HTTP" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Authenticated signaling" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Relay data lane" })).toBeInTheDocument()
    expect(
      screen.getByRole("article", { name: "Authenticated signaling failures" })
    ).toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Relay runtime upgrade" })).toBeInTheDocument()
    expect(screen.getByText("Relay data lane interruption")).toBeInTheDocument()
    expect(screen.getByTestId("monitoring-coverage")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Atom feed" })).toBeInTheDocument()
    // Nothing from the retired preview survives.
    expect(screen.queryByText(/preview/i)).toBeNull()
    expect(screen.queryByText(/Agent Runtime|Asia Pacific/)).toBeNull()
  })

  it("shows unknown with a retry when no snapshot could be loaded", async () => {
    serve(() => Promise.reject(new TypeError("offline")))
    render(<PublicStatusPage />)
    await flush()
    expect(screen.getByTestId("overall-status")).toHaveAttribute("data-status", "unknown")
    expect(screen.getByTestId("status-unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Signaling HTTP" })).toBeNull()

    serve(createStatusFixture("operational", "90d"))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await flush()
    expect(screen.getByTestId("overall-status")).toHaveTextContent("All components operational")
  })

  it("treats an unsupported schema as unavailable, not as a preview", async () => {
    serve(() => respond(200, { ...createStatusFixture("operational", "90d"), schemaVersion: 2 }))
    render(<PublicStatusPage />)
    await flush()
    expect(screen.getByTestId("overall-status")).toHaveAttribute("data-status", "unknown")
    expect(screen.getByTestId("status-unavailable")).toHaveTextContent("newer data format")
  })

  it("keeps the last snapshot with an error banner when a refresh fails", async () => {
    const snapshot = createStatusFixture("operational", "90d")
    fetchMock.mockResolvedValueOnce(respond(200, snapshot))
    fetchMock.mockRejectedValue(new TypeError("offline"))
    render(<PublicStatusPage />)
    await flush()
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    await flush()
    expect(screen.getByTestId("refresh-error")).toHaveTextContent("could not be reached")
    expect(screen.getByTestId("overall-status")).toHaveTextContent("All components operational")
  })

  it("switches the history range and requests that range", async () => {
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    serve(createStatusFixture("operational", "24h"))
    fireEvent.click(screen.getByRole("radio", { name: "24 hours" }))
    await flush()
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/status/v1/snapshot?range=24h")
    expect(screen.getByText("Last 24 hours")).toBeInTheDocument()
  })

  it("opens an incident from a deep link and keeps the URL in sync", async () => {
    window.history.replaceState(null, "", `/status/?incident=${FIXTURE_ACTIVE_INCIDENT.id}`)
    serve(createStatusFixture("major_outage", "90d"))
    render(<PublicStatusPage />)
    await flush()
    const dialog = screen.getByRole("dialog", { name: "Authenticated signaling failures" })
    expect(dialog).toHaveTextContent("Three consecutive reference checks failed")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(window.location.search).toBe("")
  })

  it("explains a deep link to an incident that does not exist", async () => {
    window.history.replaceState(null, "", "/status/?incident=inc_gone")
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    expect(screen.getByRole("dialog")).toHaveTextContent("This incident could not be found.")
  })

  it("clears a token fragment at once and asks before confirming", async () => {
    window.history.replaceState(null, "", `/status/#action=confirm&token=${TOKEN}`)
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    expect(window.location.hash).toBe("")
    expect(screen.getByRole("dialog", { name: "Confirm your subscription" })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/subscriptions"))).toBe(false)
  })

  it("on a mirror warns that data may be stale and offers no signup form", async () => {
    setMeta(JSON.stringify({ mode: "mirror", apiBase: "/mirror/api" }))
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe("/mirror/api/snapshot?range=90d")
    expect(screen.getByTestId("mirror-notice")).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole("button", { name: "Subscribe" })[0]!)
    const dialog = screen.getByRole("dialog", { name: "Subscribe to status updates" })
    expect(within(dialog).queryByLabelText("Email address")).toBeNull()
    expect(
      within(dialog).getByRole("link", { name: "Subscribe on the primary page" })
    ).toBeInTheDocument()
  })

  it("inside Cognia reads the official API and opens the primary page to subscribe", async () => {
    setMeta(null)
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://status.cognia.cn/api/status/v1/snapshot?range=90d"
    )
    fireEvent.click(screen.getAllByRole("button", { name: "Subscribe" })[0]!)
    expect(openExternal).toHaveBeenCalledWith("https://status.cognia.cn/status/")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("subscribes on the primary page", async () => {
    serve(createStatusFixture("operational", "90d"))
    render(<PublicStatusPage />)
    await flush()
    fireEvent.click(screen.getAllByRole("button", { name: "Subscribe" })[0]!)
    const dialog = screen.getByRole("dialog", { name: "Subscribe to status updates" })
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument()
  })
})
