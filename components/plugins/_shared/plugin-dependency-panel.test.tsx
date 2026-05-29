import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { PluginManifest } from "@/types/plugin"
import { PluginDependencyPanel } from "./plugin-dependency-panel"

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

const detectCliMock = jest.fn()
jest.mock("@/lib/cli-bridge/detect-cli", () => ({
  ...jest.requireActual("@/lib/cli-bridge/detect-cli"),
  detectCli: (...args: unknown[]) => detectCliMock(...args),
}))

const messages = {
  plugins: {
    dependencies: {
      title: "Dependencies",
      pluginDeps: "Plugins",
      binaries: "Required tools",
      pythonDeps: "Python packages",
      installed: "Installed",
      missing: "Missing",
      optional: "optional",
      detected: "found",
      notFound: "not found",
      checking: "checking…",
      minVersion: "≥ {version}",
    },
  },
}

function renderPanel(manifest: Partial<PluginManifest>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PluginDependencyPanel manifest={manifest as PluginManifest} />
    </NextIntlClientProvider>
  )
}

describe("PluginDependencyPanel", () => {
  beforeEach(() => {
    useLiveQueryMock.mockReturnValue([{ id: "dep.installed" }])
    detectCliMock.mockResolvedValue({ available: false, version: null, path: null, error: "web" })
  })
  afterEach(() => jest.clearAllMocks())

  it("renders nothing when the manifest declares no dependencies", () => {
    const { container } = renderPanel({})
    expect(container.firstChild).toBeNull()
  })

  it("marks plugin deps installed / missing", () => {
    renderPanel({
      dependencies: { "dep.installed": "^1.0.0", "dep.absent": "^2.0.0" },
    })
    expect(screen.getByTestId("dep-dep.installed")).toHaveTextContent("Installed")
    expect(screen.getByTestId("dep-dep.absent")).toHaveTextContent("Missing")
  })

  it("probes required binaries and shows the detected version", async () => {
    detectCliMock.mockResolvedValue({
      available: true,
      version: "2.43.0",
      path: "/usr/bin/git",
      error: null,
    })
    renderPanel({ requires: { binaries: [{ name: "git", minVersion: "2.0.0" }] } })
    await waitFor(() => expect(screen.getByTestId("binary-git")).toHaveTextContent("2.43.0"))
    expect(detectCliMock).toHaveBeenCalledWith("git")
  })

  it("flags a missing binary", async () => {
    detectCliMock.mockResolvedValue({ available: false, version: null, path: null, error: "web" })
    renderPanel({ requires: { binaries: [{ name: "cognia" }] } })
    await waitFor(() => expect(screen.getByTestId("binary-cognia")).toHaveTextContent("not found"))
  })

  it("lists python dependencies", () => {
    renderPanel({ pythonDependencies: ["requests>=2", "numpy"] })
    expect(screen.getByText("requests>=2")).toBeInTheDocument()
    expect(screen.getByText("numpy")).toBeInTheDocument()
  })
})
