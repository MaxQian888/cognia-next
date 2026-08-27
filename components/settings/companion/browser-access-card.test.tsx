/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${Object.values(values).join(",")}` : `${namespace}.${key}`,
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: jest.fn() },
}))

import { BrowserAccessCard, type BrowserAccessSummary } from "./browser-access-card"

const BASE: BrowserAccessSummary = {
  enabled: false,
  allowedOrigins: [],
  port: 27891,
  boundPort: null,
  suggestedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  browserBaseUrl: null,
  primaryOrigin: null,
}

const summary = (overrides: Partial<BrowserAccessSummary> = {}): BrowserAccessSummary => ({
  ...BASE,
  ...overrides,
})

beforeEach(() => {
  tauri = true
})

it("renders nothing off the desktop shell, where there is no listener to configure", async () => {
  tauri = false
  const load = jest.fn()
  const { container } = render(<BrowserAccessCard load={load} save={jest.fn()} />)
  expect(container).toBeEmptyDOMElement()
  expect(load).not.toHaveBeenCalled()
})

it("separates a saved port from a bound one, because that gap is the restart", async () => {
  // Configured + allowlisted + not listening is exactly what "restart to
  // apply" looks like. Showing one number would make it indistinguishable
  // from a working listener.
  render(
    <BrowserAccessCard
      load={() =>
        Promise.resolve(summary({ enabled: true, allowedOrigins: ["http://localhost:3000"] }))
      }
      save={jest.fn()}
    />
  )
  await screen.findByTestId("browser-access-card")
  expect(screen.getByTestId("browser-access-idle")).toBeInTheDocument()
  expect(screen.getByTestId("browser-access-restart")).toBeInTheDocument()
})

it("shows the address a browser should actually use once the listener is live", async () => {
  render(
    <BrowserAccessCard
      load={() =>
        Promise.resolve(
          summary({
            enabled: true,
            allowedOrigins: ["http://localhost:3000"],
            boundPort: 27891,
            browserBaseUrl: "http://127.0.0.1:27891",
          })
        )
      }
      save={jest.fn()}
    />
  )
  const badge = await screen.findByTestId("browser-access-listening")
  expect(badge).toHaveTextContent("http://127.0.0.1:27891")
  expect(screen.queryByTestId("browser-access-restart")).not.toBeInTheDocument()
})

it("says plainly that an empty allowlist does nothing", async () => {
  // A listener with no origins binds and then answers 403 to every request a
  // browser makes — indistinguishable from a closed port unless we say so.
  render(
    <BrowserAccessCard load={() => Promise.resolve(summary({ enabled: true }))} save={jest.fn()} />
  )
  expect(await screen.findByTestId("browser-access-no-origins")).toBeInTheDocument()
})

it("adds a typed origin and hands the whole config to the host", async () => {
  const save = jest.fn().mockResolvedValue(summary({ allowedOrigins: ["http://localhost:5173"] }))
  render(<BrowserAccessCard load={() => Promise.resolve(summary())} save={save} />)
  await screen.findByTestId("browser-access-card")

  fireEvent.change(screen.getByLabelText("mobile.companion.browserAccess.origins.add"), {
    target: { value: "http://localhost:5173" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "mobile.companion.browserAccess.origins.add" })
  )

  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      enabled: false,
      allowedOrigins: ["http://localhost:5173"],
      port: 27891,
    })
  )
  expect(await screen.findByTestId("browser-access-origins")).toHaveTextContent(
    "http://localhost:5173"
  )
})

it("offers only the suggestions that are not already allowed", async () => {
  render(
    <BrowserAccessCard
      load={() => Promise.resolve(summary({ allowedOrigins: ["http://localhost:3000"] }))}
      save={jest.fn()}
    />
  )
  const suggested = await screen.findByTestId("browser-access-suggested")
  expect(suggested).toHaveTextContent("http://127.0.0.1:3000")
  expect(screen.queryByRole("button", { name: "http://localhost:3000" })).not.toBeInTheDocument()
})

it("removes an origin without disturbing the enabled flag", async () => {
  const save = jest.fn().mockResolvedValue(summary({ enabled: true, allowedOrigins: ["b"] }))
  render(
    <BrowserAccessCard
      load={() => Promise.resolve(summary({ enabled: true, allowedOrigins: ["a", "b"] }))}
      save={save}
    />
  )
  await screen.findByTestId("browser-access-origins")
  fireEvent.click(screen.getByLabelText("mobile.companion.browserAccess.origins.revoke:a"))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ enabled: true, allowedOrigins: ["b"], port: 27891 })
  )
})

it("surfaces the host's refusal instead of swallowing it", async () => {
  // Rust refuses a non-exact origin and refuses to enable with an empty list.
  // Both are the user's to fix, so the reason has to reach them.
  const save = jest
    .fn()
    .mockRejectedValue(new Error("`nope` is not an exact http(s) browser origin"))
  render(<BrowserAccessCard load={() => Promise.resolve(summary())} save={save} />)
  await screen.findByTestId("browser-access-card")

  fireEvent.change(screen.getByLabelText("mobile.companion.browserAccess.origins.add"), {
    target: { value: "nope" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "mobile.companion.browserAccess.origins.add" })
  )

  expect(await screen.findByTestId("browser-access-error")).toHaveTextContent(
    "is not an exact http(s) browser origin"
  )
})

it("toggles the listener through the same save the origin editors use", async () => {
  const save = jest.fn().mockResolvedValue(summary({ enabled: true, allowedOrigins: ["a"] }))
  render(
    <BrowserAccessCard
      load={() => Promise.resolve(summary({ allowedOrigins: ["a"] }))}
      save={save}
    />
  )
  await screen.findByTestId("browser-access-card")
  fireEvent.click(screen.getByLabelText("mobile.companion.browserAccess.enable"))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ enabled: true, allowedOrigins: ["a"], port: 27891 })
  )
})
