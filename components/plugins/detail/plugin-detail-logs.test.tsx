/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    return t
  },
}))

const getRuntimeInfoMock = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(() => ({ getPythonRuntimeInfo: getRuntimeInfoMock })),
}))

import { appendPythonEvent, __resetPythonLogBufferForTesting } from "@/lib/plugin/python/log-buffer"
import { PluginDetailLogs } from "./plugin-detail-logs"

/** Render and flush the async runtime-info effect (avoids act warnings). */
async function renderLogs() {
  render(<PluginDetailLogs pluginId="demo" />)
  await act(async () => {
    await Promise.resolve()
  })
}

describe("PluginDetailLogs", () => {
  beforeEach(() => {
    __resetPythonLogBufferForTesting()
    getRuntimeInfoMock.mockReset()
    getRuntimeInfoMock.mockResolvedValue({
      available: true,
      version: "3.14.0",
      plugin_count: 2,
      lazy_hosts: 1,
      total_calls: 7,
      total_execution_time_ms: 10,
      failed_calls: 0,
    })
  })

  it("shows the empty state when nothing is buffered", async () => {
    await renderLogs()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders buffered entries and live-appends new ones", async () => {
    appendPythonEvent({ pluginId: "demo", kind: "log", data: { line: "hello world" } }, 1000)
    await renderLogs()
    expect(screen.getByText("hello world")).toBeInTheDocument()

    act(() => {
      appendPythonEvent(
        { pluginId: "demo", kind: "progress", data: { phase: "pip", message: "numpy", pct: 40 } },
        2000
      )
    })
    expect(screen.getByText("[pip] numpy (40%)")).toBeInTheDocument()
  })

  it("ignores events for other plugins", async () => {
    appendPythonEvent({ pluginId: "other", kind: "log", data: { line: "not mine" } }, 1)
    await renderLogs()
    expect(screen.queryByText("not mine")).not.toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders chunk / chunk_end / exit kinds", async () => {
    appendPythonEvent({ pluginId: "demo", kind: "chunk", callId: 3, data: "partial" }, 1)
    appendPythonEvent({ pluginId: "demo", kind: "chunk_end", callId: 3, data: null }, 2)
    appendPythonEvent({ pluginId: "demo", kind: "exit", data: null }, 3)
    await renderLogs()
    expect(screen.getByText("partial")).toBeInTheDocument()
    expect(screen.getByText("streamEnd")).toBeInTheDocument()
    expect(screen.getByText("exited")).toBeInTheDocument()
  })

  it("falls back to JSON for unknown kinds and structured payloads", async () => {
    appendPythonEvent({ pluginId: "demo", kind: "mystery", data: { weird: 1 } }, 1)
    appendPythonEvent({ pluginId: "demo", kind: "log", data: { notLine: true } }, 2)
    appendPythonEvent({ pluginId: "demo", kind: "progress", data: {} }, 3)
    appendPythonEvent({ pluginId: "demo", kind: "chunk", data: { piece: 2 } }, 4)
    await renderLogs()
    expect(screen.getByText('{"weird":1}')).toBeInTheDocument()
    expect(screen.getByText('{"notLine":true}')).toBeInTheDocument()
    expect(screen.getByText("{}")).toBeInTheDocument()
    expect(screen.getByText('{"piece":2}')).toBeInTheDocument()
  })

  it("clear button empties the buffer", async () => {
    appendPythonEvent({ pluginId: "demo", kind: "log", data: { line: "to clear" } }, 1)
    await renderLogs()
    fireEvent.click(screen.getByRole("button", { name: /clear/ }))
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("surfaces the runtime strip from the manager", async () => {
    await renderLogs()
    await waitFor(() => expect(screen.getByTestId("python-runtime-strip")).toBeInTheDocument())
    expect(screen.getByTestId("python-runtime-strip").textContent).toContain('"lazy":1')
  })

  it("hides the runtime strip when the manager is unavailable", async () => {
    getRuntimeInfoMock.mockRejectedValue(new Error("web mode"))
    await renderLogs()
    expect(screen.queryByTestId("python-runtime-strip")).not.toBeInTheDocument()
  })
})
