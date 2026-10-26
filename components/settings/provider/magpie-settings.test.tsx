/** @jest-environment jsdom */
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/magpie/client", () => ({ discoverLocalMagpie: jest.fn() }))
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { discoverLocalMagpie } from "@/lib/magpie/client"
import { MagpieSettings } from "./magpie-settings"
const discovery = jest.mocked(discoverLocalMagpie)
beforeEach(() => jest.resetAllMocks())

it("saves a discovered gateway without replacing sibling provider settings", async () => {
  discovery.mockResolvedValue({
    baseURL: "http://127.0.0.1:18995/v1",
    version: "0.1.1318",
    models: [{ id: "native/coder", name: "Native" }],
  })
  const save = jest.fn()
  render(<MagpieSettings onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: "discover" }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      baseURL: "http://127.0.0.1:18995/v1",
      apiKey: "magpie-cognia",
      enabled: true,
      discoveredModels: [{ id: "native/coder", name: "Native" }],
      discoveredModelsLastFetched: expect.any(Number),
      defaultModel: "native/coder",
      enabledModels: undefined,
    })
  )
})

it("preserves a selected model that still exists in the current catalog", async () => {
  discovery.mockResolvedValue({
    baseURL: "http://127.0.0.1:18995/v1",
    version: "test",
    models: [{ id: "native/first" }, { id: "group/chosen" }],
  })
  const save = jest.fn()
  render(
    <MagpieSettings
      settings={{ providerId: "magpie", defaultModel: "group/chosen", enabled: true }}
      onSave={save}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "discover" }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "group/chosen" }))
  )
})

it("shows discovery failure and leaves configured providers untouched", async () => {
  discovery.mockRejectedValue(new Error("Gateway offline"))
  const save = jest.fn()
  render(<MagpieSettings onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: "discover" }))
  expect(await screen.findByText("Gateway offline")).toBeInTheDocument()
  expect(save).not.toHaveBeenCalled()
})

it("cancels discovery on unmount and never persists its late response", async () => {
  let finish!: (value: Awaited<ReturnType<typeof discoverLocalMagpie>>) => void
  discovery.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const save = jest.fn(),
    view = render(<MagpieSettings onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: "discover" }))
  const signal = discovery.mock.calls[0][0]!
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () =>
    finish({ baseURL: "http://127.0.0.1:18995/v1", version: "test", models: [] })
  )
  expect(save).not.toHaveBeenCalled()
})

it("does not overwrite settings changed while discovery is pending", async () => {
  let finish!: (value: Awaited<ReturnType<typeof discoverLocalMagpie>>) => void
  discovery.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const save = jest.fn()
  const view = render(
    <MagpieSettings
      settings={{ providerId: "magpie", enabled: true, defaultModel: "native/old" }}
      onSave={save}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "discover" }))
  view.rerender(
    <MagpieSettings
      settings={{ providerId: "magpie", enabled: true, defaultModel: "native/new" }}
      onSave={save}
    />
  )
  await act(async () =>
    finish({
      baseURL: "http://127.0.0.1:18995/v1",
      version: "test",
      models: [{ id: "native/old" }],
    })
  )
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "discover" })).toBeEnabled()
})
