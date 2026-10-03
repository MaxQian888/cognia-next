/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { PluginType } from "@/types/plugin"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const trustState = new Map<string, boolean>()
const setFrontendTrust = jest.fn((id: string, on: boolean) => {
  trustState.set(id, on)
})
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    isFrontendTrusted: (id: string) => trustState.get(id) ?? false,
    setFrontendTrust,
  }),
}))

import { PluginFrontendTrustCard } from "./plugin-frontend-trust-card"

describe("PluginFrontendTrustCard", () => {
  beforeEach(() => {
    trustState.clear()
    setFrontendTrust.mockClear()
  })

  it("renders for an untrusted-source frontend plugin with the blocked hint", () => {
    render(<PluginFrontendTrustCard pluginId="a" type="frontend" source="local" />)
    expect(screen.getByTestId("plugin-frontend-trust-card")).toBeInTheDocument()
    expect(screen.getByText("blockedHint")).toBeInTheDocument()
    expect(screen.getByRole("switch")).not.toBeChecked()
  })

  it.each(["builtin", "dev"] as const)(
    "does not render for the inherently trusted source %s",
    (source) => {
      const { container } = render(
        <PluginFrontendTrustCard pluginId="a" type="frontend" source={source} />
      )
      expect(container).toBeEmptyDOMElement()
    }
  )

  it.each(["wasm", "python"] as PluginType[])(
    "does not render for the isolated-host type %s",
    (type) => {
      const { container } = render(
        <PluginFrontendTrustCard pluginId="a" type={type} source="local" />
      )
      expect(container).toBeEmptyDOMElement()
    }
  )

  it("asks to trust a VS Code extension no Open VSX signature vouches for, in its own words", () => {
    render(<PluginFrontendTrustCard pluginId="a" type="vscode-extension" source="local" />)
    expect(screen.getByText("vscode.title")).toBeInTheDocument()
    expect(screen.getByText("vscode.description")).toBeInTheDocument()
    expect(screen.getByText("vscode.blockedHint")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toHaveAccessibleName("vscode.switchAria")

    fireEvent.click(screen.getByRole("switch"))
    expect(setFrontendTrust).toHaveBeenCalledWith("a", true)
  })

  it("does not render for a VS Code extension Open VSX signed, or one in development", () => {
    const signed = render(
      <PluginFrontendTrustCard
        pluginId="a"
        type="vscode-extension"
        source="marketplace"
        signedByOpenVsx
      />
    )
    expect(signed.container).toBeEmptyDOMElement()
    signed.unmount()
    const dev = render(
      <PluginFrontendTrustCard pluginId="a" type="vscode-extension" source="dev" />
    )
    expect(dev.container).toBeEmptyDOMElement()
  })

  it("grants trust via the manager and hides the blocked hint once trusted", () => {
    render(<PluginFrontendTrustCard pluginId="a" type="hybrid" source="marketplace" />)
    expect(screen.getByText("blockedHint")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("switch"))

    expect(setFrontendTrust).toHaveBeenCalledWith("a", true)
    expect(screen.queryByText("blockedHint")).not.toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeChecked()
  })

  it("reflects an already-trusted plugin as checked with no blocked hint", () => {
    trustState.set("a", true)
    render(<PluginFrontendTrustCard pluginId="a" type="frontend" source="git" />)
    expect(screen.getByRole("switch")).toBeChecked()
    expect(screen.queryByText("blockedHint")).not.toBeInTheDocument()
  })
})
