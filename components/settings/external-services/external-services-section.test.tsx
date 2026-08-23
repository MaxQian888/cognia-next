/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [
    {
      id: "connection-1",
      pluginId: "figma",
      serviceId: "figma",
      providerId: "desktop",
      runtimeTargetId: "local",
      accountLabel: "Figma Desktop",
      status: "connected",
      providerFingerprint: "fp",
      providerRef: { kind: "mcp", serverId: "server-1" },
      enabledSurfaces: ["chat", "workflow"],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
  ],
}))
jest.mock("@/lib/external-services/catalog", () => ({
  subscribeExternalServiceCatalog: () => () => undefined,
  getExternalServiceCatalogRevision: () => 1,
  listExternalServices: () => [],
}))
jest.mock("@/lib/external-services/providers/browser", () => ({
  connectBrowserSite: jest.fn(async () => undefined),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { connectBrowserSite } from "@/lib/external-services/providers/browser"
import { ExternalServicesSection } from "./external-services-section"

const mockedConnectBrowserSite = jest.mocked(connectBrowserSite)

describe("ExternalServicesSection", () => {
  beforeEach(() => mockedConnectBrowserSite.mockClear())

  it("renders provider, risk surfaces, and lifecycle flow", () => {
    render(<ExternalServicesSection />)
    expect(screen.getByText("Figma Desktop")).toBeInTheDocument()
    expect(screen.getByText("surface.chat")).toBeInTheDocument()
    expect(screen.getByText("flow.install")).toBeInTheDocument()
    expect(screen.getByText("flow.manage")).toBeInTheDocument()
  })

  it("creates a generic website connection from reviewed domains", async () => {
    render(<ExternalServicesSection />)
    fireEvent.click(screen.getByText("website.connect"))
    fireEvent.change(screen.getByLabelText("website.name"), { target: { value: "Example" } })
    fireEvent.change(screen.getByLabelText("website.domains"), {
      target: { value: "example.com" },
    })
    fireEvent.change(screen.getByLabelText("website.loginUrl"), {
      target: { value: "https://example.com/login" },
    })
    fireEvent.click(screen.getByText("actions.create"))
    await waitFor(() =>
      expect(mockedConnectBrowserSite).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Example",
          domains: ["example.com"],
          loginStartUrl: "https://example.com/login",
        })
      )
    )
  })
})
