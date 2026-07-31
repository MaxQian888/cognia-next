/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    return t
  },
}))

const getStatusesMock = jest.fn()
jest.mock("@/lib/plugin/cli-tools/binary-status", () => ({
  getPluginBinaryStatuses: (manifest: unknown) => getStatusesMock(manifest),
}))

const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}))

import { PluginCliToolsSection } from "./plugin-cli-tools-section"
import type { PluginManifest } from "@/types/plugin"

const MANIFEST = {
  id: "ripgrep-tools",
  name: "Ripgrep Tools",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: ["cli-tools"],
  requires: {
    binaries: [{ name: "rg", minVersion: "13.0.0", documentation: "https://example.com/install" }],
  },
  cliTools: [
    {
      name: "ripgrep_search",
      description: "Search files",
      parameters: { type: "object", properties: { pattern: { type: "string" } } },
      binary: { kind: "requires", name: "rg" },
      argv: [{ param: "pattern" }],
    },
  ],
} as unknown as PluginManifest

async function renderSection(manifest: PluginManifest = MANIFEST) {
  render(<PluginCliToolsSection manifest={manifest} />)
  await act(async () => {
    await Promise.resolve()
  })
}

describe("PluginCliToolsSection", () => {
  beforeEach(() => {
    getStatusesMock.mockReset()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it("renders nothing when the manifest declares no cliTools", async () => {
    getStatusesMock.mockResolvedValue([])
    await renderSection({ ...MANIFEST, cliTools: [] } as PluginManifest)
    expect(screen.queryByTestId("plugin-cli-tools-section")).not.toBeInTheDocument()
  })

  it("shows the available pill with the detected version", async () => {
    getStatusesMock.mockResolvedValue([
      { name: "rg", available: true, version: "14.1.0", path: "C:/rg", satisfiesMin: true },
    ])
    await renderSection()
    await waitFor(() =>
      expect(screen.getByTestId("cli-binary-ok-ripgrep_search")).toBeInTheDocument()
    )
    expect(screen.getByText("ripgrep_search")).toBeInTheDocument()
  })

  it("shows missing pill + install link when the binary is absent", async () => {
    getStatusesMock.mockResolvedValue([
      {
        name: "rg",
        available: false,
        version: null,
        path: null,
        satisfiesMin: false,
        documentation: "https://example.com/install",
      },
    ])
    await renderSection()
    await waitFor(() =>
      expect(screen.getByTestId("cli-binary-missing-ripgrep_search")).toBeInTheDocument()
    )
    const link = screen.getByRole("link", { name: /installHelp/ })
    expect(link).toHaveAttribute("href", "https://example.com/install")
  })

  it("shows the below-minimum pill for outdated binaries", async () => {
    getStatusesMock.mockResolvedValue([
      {
        name: "rg",
        available: true,
        version: "12.0.0",
        path: "C:/rg",
        satisfiesMin: false,
        minVersion: "13.0.0",
        documentation: "https://example.com/install",
      },
    ])
    await renderSection()
    await waitFor(() =>
      expect(screen.getByTestId("cli-binary-old-ripgrep_search")).toBeInTheDocument()
    )
  })

  it("re-probe invalidates the native cache then probes again", async () => {
    getStatusesMock.mockResolvedValue([
      { name: "rg", available: false, version: null, path: null, satisfiesMin: false },
    ])
    await renderSection()
    await waitFor(() => expect(getStatusesMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: /reprobe/ }))
    await waitFor(() => expect(getStatusesMock).toHaveBeenCalledTimes(2))
    expect(invokeMock).toHaveBeenCalledWith("detect_binary_invalidate", { name: "rg" })
  })
})
