import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BridgeSetupPanel } from "./setup-panel"
import type { ExternalBridgeSettings } from "@/types/wiki"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockResolveSidecarPath = jest.fn()
jest.mock("../bridge-runtime", () => ({
  ...jest.requireActual("../bridge-runtime"),
  resolveSidecarPath: () => mockResolveSidecarPath(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

function setup(over: Partial<ExternalBridgeSettings> = {}) {
  const settings = {
    enabled: true,
    enabledScopes: [],
    bearerToken: "tok_abc",
    ...over,
  } as ExternalBridgeSettings
  render(<BridgeSetupPanel settings={settings} />)
}

beforeEach(() => {
  mockResolveSidecarPath.mockReset().mockResolvedValue("/Users/dev/.cognia/cognia-mcp.js")
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("BridgeSetupPanel", () => {
  it("uses the resolved sidecar path, not a placeholder the user must edit", async () => {
    // Regression: the stdio variant printed a literal `/path/to/cognia-mcp.js`
    // while `resolveSidecarPath()` sat in the same file computing the real one.
    setup()

    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent(
        "/Users/dev/.cognia/cognia-mcp.js"
      )
    )
    expect(screen.getByTestId("bridge-setup-snippet")).not.toHaveTextContent("/path/to/")
  })

  it("defaults the HTTP port to 3001 so a snippet copied before first start still points somewhere", async () => {
    // The two readers used to disagree: `startMcpServer` passed `?? 0` (OS
    // assigns) while the snippet printed `?? 3001`.
    const user = userEvent.setup()
    setup({ httpPort: undefined })

    await user.click(screen.getByRole("combobox", { name: "setup.clientLabel" }))
    await user.click(await screen.findByRole("option", { name: "setup.variants.cursor" }))

    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent("127.0.0.1:3001")
    )
  })

  it("uses the configured port once one is set", async () => {
    const user = userEvent.setup()
    setup({ httpPort: 4444 })

    await user.click(screen.getByRole("combobox", { name: "setup.clientLabel" }))
    await user.click(await screen.findByRole("option", { name: "setup.variants.cursor" }))

    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent("127.0.0.1:4444")
    )
  })

  it("embeds the bearer token in the HTTP variants", async () => {
    const user = userEvent.setup()
    setup({ bearerToken: "tok_abc" })

    await user.click(screen.getByRole("combobox", { name: "setup.clientLabel" }))
    await user.click(await screen.findByRole("option", { name: "setup.variants.goose" }))

    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent("Bearer tok_abc")
    )
  })

  it("falls back to an obvious placeholder when no token exists yet", async () => {
    const user = userEvent.setup()
    setup({ bearerToken: undefined })

    await user.click(screen.getByRole("combobox", { name: "setup.clientLabel" }))
    await user.click(await screen.findByRole("option", { name: "setup.variants.goose" }))

    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent("setup.tokenPlaceholder")
    )
  })

  it("says the sidecar is not installed instead of printing a path that is not there", async () => {
    // The stdio snippet's whole value is being paste-ready. Synthesising
    // `~/.cognia/cognia-mcp.js` when nothing installs it produced a config
    // whose `node <path>` fails inside the child with nothing surfaced.
    mockResolveSidecarPath.mockResolvedValue(null)
    setup()

    expect(await screen.findByTestId("bridge-sidecar-missing")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent(
        "setup.sidecarMissingPlaceholder"
      )
    )
  })

  it("does not claim a missing sidecar on the transports that do not need one", async () => {
    mockResolveSidecarPath.mockResolvedValue(null)
    const user = userEvent.setup()
    setup()
    await screen.findByTestId("bridge-sidecar-missing")

    await user.click(screen.getByRole("combobox", { name: "setup.clientLabel" }))
    await user.click(await screen.findByRole("option", { name: "setup.variants.goose" }))

    await waitFor(() =>
      expect(screen.queryByTestId("bridge-sidecar-missing")).not.toBeInTheDocument()
    )
  })

  it("copies the rendered snippet", async () => {
    // `navigator.clipboard` is a read-only accessor in jsdom and
    // `userEvent.setup()` installs its own stub over it — so define the spy
    // directly and drive the click with fireEvent.
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("bridge-setup-snippet")).toHaveTextContent("cognia-mcp.js")
    )

    fireEvent.click(screen.getByRole("button", { name: "setup.copyAria" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("cognia-mcp.js"))
    )
  })
})
