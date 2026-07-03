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

  it("edits the delivery limits and clamps out-of-range input", async () => {
    render(<OutboundTab />)
    const retries = screen.getByLabelText(/max retries/i) as HTMLInputElement
    expect(retries.value).toBe("3")
    fireEvent.change(retries, { target: { value: "6" } })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.delivery?.maxRetries).toBe(6)
    )
    // 999 is clamped to the max of 10.
    fireEvent.change(retries, { target: { value: "999" } })
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.delivery?.maxRetries).toBe(10)
    )
  })

  it("resets the delivery limits to defaults", async () => {
    await useRemoteControlStore
      .getState()
      .updateOutbound({ delivery: { maxRetries: 9, timeoutMs: 30000, baseDelayMs: 5000 } })
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.delivery).toEqual({
        maxRetries: 3,
        timeoutMs: 10000,
        baseDelayMs: 1000,
      })
    )
  })

  it("toggles an endpoint event subscription", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints).toHaveLength(1)
    )
    fireEvent.click(screen.getByLabelText(/task completed/i))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints[0].eventTypes).toEqual([
        "complete",
      ])
    )
  })

  it("flags an invalid endpoint URL", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    const urlInput = await screen.findByPlaceholderText("https://example.com/webhook")
    fireEvent.change(urlInput, { target: { value: "not-a-url" } })
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })

  it("adds a per-endpoint custom header", async () => {
    render(<OutboundTab />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints).toHaveLength(1)
    )
    // The endpoints card renders before the global default-headers card, so the
    // first "Add header" button is the per-endpoint one.
    fireEvent.click(screen.getAllByRole("button", { name: /add header/i })[0])
    await waitFor(() =>
      expect(useRemoteControlStore.getState().config.outbound.endpoints[0].headers).toHaveLength(1)
    )
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
