/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { OutboundTab } from "./outbound-tab"
import { useRemoteControlStore } from "@/stores/remote-control/store"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

beforeEach(() => {
  jest.clearAllMocks()
  useRemoteControlStore.getState().reset()
})

describe("OutboundTab", () => {
  it("warns when no signing secret is set", () => {
    render(<OutboundTab />)
    expect(screen.getByText(/no signing secret/i)).toBeInTheDocument()
  })

  it("saves a signing secret and clears the input after success", async () => {
    render(<OutboundTab />)
    const input = screen.getByPlaceholderText(/strong shared secret/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "hunter2" } })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(true)
    )
    expect(input.value).toBe("")
  })

  it("clears the secret via the clear button", async () => {
    useRemoteControlStore.setState({
      config: {
        ...useRemoteControlStore.getState().config,
        outbound: { hasSigningSecret: true, defaultHeaders: [], endpoints: [] },
      },
    })
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.hasSigningSecret).toBe(false)
    )
  })

  it("adds, edits, and removes default headers", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /add header/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.defaultHeaders).toHaveLength(1)
    )
    const nameInput = screen.getByPlaceholderText(/Header name/i) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "X-Foo" } })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.defaultHeaders[0].name).toBe("X-Foo")
    )
    fireEvent.click(screen.getByRole("button", { name: /remove/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.defaultHeaders).toHaveLength(0)
    )
  })

  it("renders the read-only retry summary", () => {
    render(<OutboundTab />)
    expect(screen.getByText(/Retries.*3.*1000.*10000/i)).toBeInTheDocument()
  })

  it("adds, edits, and removes an egress endpoint", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints).toHaveLength(1)
    )
    const nameInput = screen.getByPlaceholderText(/Endpoint name/i) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "My hook" } })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints[0].name).toBe("My hook")
    )
    const urlInput = screen.getByPlaceholderText("https://example.com/webhook") as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: "https://x.test/h" } })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints[0].url).toBe(
        "https://x.test/h"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /remove endpoint/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints).toHaveLength(0)
    )
  })
})
