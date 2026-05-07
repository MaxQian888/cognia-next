/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriCoreModule = require("@tauri-apps/api/core") as { invoke: jest.Mock }
const invokeMock = tauriCoreModule.invoke

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriModule = require("@/lib/tauri") as { isTauri: jest.Mock }
const isTauriMock = tauriModule.isTauri

import { NetworkTestTab } from "./test-tab"

beforeEach(() => {
  invokeMock.mockClear()
  isTauriMock.mockReturnValue(true)
})

describe("NetworkTestTab", () => {
  it("renders the URL input + Run button", () => {
    render(<NetworkTestTab />)
    expect(screen.getByLabelText("test.urlLabel")).toBeInTheDocument()
    expect(screen.getByText("test.run")).toBeInTheDocument()
  })

  it("disables the button while running", async () => {
    let resolve: ((v: unknown) => void) | null = null
    invokeMock.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<NetworkTestTab />)
    fireEvent.click(screen.getByText("test.run"))
    expect(screen.getByText("test.running")).toBeInTheDocument()
    await act(async () => {
      resolve?.({ ok: true, latencyMs: 42, status: 200 })
    })
  })

  it("renders the success card with latency + status", async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      latencyMs: 123,
      status: 200,
      proxyUrl: "http://127.0.0.1:7890",
    })
    render(<NetworkTestTab />)
    await act(async () => {
      fireEvent.click(screen.getByText("test.run"))
    })
    await waitFor(() => {
      expect(screen.getByText("test.success")).toBeInTheDocument()
    })
    expect(screen.getByText("123 ms")).toBeInTheDocument()
    expect(screen.getByText("200")).toBeInTheDocument()
    expect(screen.getByText("http://127.0.0.1:7890")).toBeInTheDocument()
  })

  it("renders the failure card with the error message", async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      latencyMs: 50,
      error: "connection refused",
    })
    render(<NetworkTestTab />)
    await act(async () => {
      fireEvent.click(screen.getByText("test.run"))
    })
    await waitFor(() => {
      expect(screen.getByText("test.failure")).toBeInTheDocument()
    })
    expect(screen.getByText(/connection refused/)).toBeInTheDocument()
  })

  it("handles invoke rejection by surfacing the error in the card", async () => {
    invokeMock.mockRejectedValue(new Error("boom"))
    render(<NetworkTestTab />)
    await act(async () => {
      fireEvent.click(screen.getByText("test.run"))
    })
    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument()
    })
  })

  it("shows the web-unsupported notice when not in Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<NetworkTestTab />)
    expect(screen.getByText("test.webUnsupported")).toBeInTheDocument()
  })

  it("falls back to direct connection text when proxyUrl is absent", async () => {
    invokeMock.mockResolvedValue({ ok: true, latencyMs: 12, status: 204 })
    render(<NetworkTestTab />)
    await act(async () => {
      fireEvent.click(screen.getByText("test.run"))
    })
    await waitFor(() => {
      expect(screen.getByText("test.directConnection")).toBeInTheDocument()
    })
  })
})
