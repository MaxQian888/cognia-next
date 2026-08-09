/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WebhooksSection } from "./webhooks-section"
import { useWebhookStore } from "@/stores/webhooks/store"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
const getWebhookSigningSecretMock = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/webhooks/signing-secret", () => ({
  getWebhookSigningSecret: () => getWebhookSigningSecretMock(),
  setWebhookSigningSecret: jest.fn().mockResolvedValue(undefined),
}))

const deliverWebhookMock = jest.fn()
jest.mock("@/lib/webhooks/delivery", () => ({
  deliverWebhook: (...args: unknown[]) => deliverWebhookMock(...args),
}))

const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  getWebhookSigningSecretMock.mockResolvedValue(null)
  deliverWebhookMock.mockResolvedValue({ ok: true, httpStatus: 200 })
  useWebhookStore.getState().reset()
})

describe("WebhooksSection", () => {
  it("warns when no signing secret is set", () => {
    render(<WebhooksSection />)
    expect(screen.getByText(/no signing secret/i)).toBeInTheDocument()
  })

  it("saves a signing secret and clears the input after success", async () => {
    render(<WebhooksSection />)
    const input = screen.getByPlaceholderText(/strong shared secret/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: "hunter2" } })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.hasSigningSecret).toBe(true))
    expect(input.value).toBe("")
  })

  it("clears the secret via the clear button", async () => {
    useWebhookStore.setState({
      config: { hasSigningSecret: true, defaultHeaders: [], endpoints: [] },
    })
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.hasSigningSecret).toBe(false))
  })

  it("adds, edits, and removes default headers", async () => {
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /add header/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.defaultHeaders).toHaveLength(1))
    const nameInput = screen.getByPlaceholderText(/Header name/i) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "X-Foo" } })
    await waitFor(() =>
      expect(useWebhookStore.getState().config.defaultHeaders[0].name).toBe("X-Foo")
    )
    fireEvent.click(screen.getByRole("button", { name: /remove/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.defaultHeaders).toHaveLength(0))
  })

  it("edits the delivery limits and clamps out-of-range input", async () => {
    render(<WebhooksSection />)
    const retries = screen.getByLabelText(/max retries/i) as HTMLInputElement
    expect(retries.value).toBe("3")
    fireEvent.change(retries, { target: { value: "6" } })
    await waitFor(() => expect(useWebhookStore.getState().config.delivery?.maxRetries).toBe(6))
    // 999 is clamped to the max of 10.
    fireEvent.change(retries, { target: { value: "999" } })
    await waitFor(() => expect(useWebhookStore.getState().config.delivery?.maxRetries).toBe(10))
  })

  it("resets the delivery limits to defaults", async () => {
    await useWebhookStore
      .getState()
      .updateConfig({ delivery: { maxRetries: 9, timeoutMs: 30000, baseDelayMs: 5000 } })
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i }))
    await waitFor(() =>
      expect(useWebhookStore.getState().config.delivery).toEqual({
        maxRetries: 3,
        timeoutMs: 10000,
        baseDelayMs: 1000,
      })
    )
  })

  it("toggles an endpoint event subscription", async () => {
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.endpoints).toHaveLength(1))
    fireEvent.click(screen.getByLabelText(/task completed/i))
    await waitFor(() =>
      expect(useWebhookStore.getState().config.endpoints[0].eventTypes).toEqual(["complete"])
    )
  })

  it("flags an invalid endpoint URL", async () => {
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    const urlInput = await screen.findByPlaceholderText("https://example.com/webhook")
    fireEvent.change(urlInput, { target: { value: "not-a-url" } })
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })

  it("adds a per-endpoint custom header", async () => {
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.endpoints).toHaveLength(1))
    // The endpoints card renders before the global default-headers card, so the
    // first "Add header" button is the per-endpoint one.
    fireEvent.click(screen.getAllByRole("button", { name: /add header/i })[0])
    await waitFor(() =>
      expect(useWebhookStore.getState().config.endpoints[0].headers).toHaveLength(1)
    )
  })

  it("adds, edits, and removes an egress endpoint", async () => {
    render(<WebhooksSection />)
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.endpoints).toHaveLength(1))
    const nameInput = screen.getByPlaceholderText(/Endpoint name/i) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "My hook" } })
    await waitFor(() => expect(useWebhookStore.getState().config.endpoints[0].name).toBe("My hook"))
    const urlInput = screen.getByPlaceholderText("https://example.com/webhook") as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: "https://x.test/h" } })
    await waitFor(() =>
      expect(useWebhookStore.getState().config.endpoints[0].url).toBe("https://x.test/h")
    )
    fireEvent.click(screen.getByRole("button", { name: /remove endpoint/i }))
    await waitFor(() => expect(useWebhookStore.getState().config.endpoints).toHaveLength(0))
  })

  it("blocks an endpoint test when its configured signing secret is unavailable", async () => {
    useWebhookStore.setState({
      config: {
        ...useWebhookStore.getState().config,
        hasSigningSecret: true,
        endpoints: [
          {
            id: "endpoint-1",
            name: "Test",
            url: "https://x.test/h",
            headers: [],
            enabled: true,
          },
        ],
      },
    })
    render(<WebhooksSection />)

    fireEvent.click(screen.getByRole("button", { name: /send a test delivery/i }))

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "The configured signing secret is unavailable. Delivery was blocked."
      )
    )
    expect(deliverWebhookMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})
