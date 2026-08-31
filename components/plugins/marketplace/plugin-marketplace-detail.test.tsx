/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => true,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const getVersionsMock = jest.fn(async () => [] as Array<{ version: string }>)

// Deterministic marketplace client — no real network from the detail sheet's
// getVersions / getPlugin effects.
jest.mock("@/hooks/plugins/use-plugin-marketplace", () => ({
  loadPluginMarketplaceClient: async () => ({
    getVersions: getVersionsMock,
    getPlugin: async () => null,
  }),
}))

// Stub the AI Elements CodeBlock (async Shiki) so the manifest dialog stays
// synchronous and its composition can be asserted.
const codeBlockPropsMock = jest.fn()
jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: (props: { code: string; language?: string; children?: React.ReactNode }) => {
    codeBlockPropsMock(props)
    return (
      <div data-testid="manifest-code-block">
        {props.children}
        <pre data-testid="manifest-code">{props.code}</pre>
      </div>
    )
  },
  CodeBlockHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockFilename: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  CodeBlockActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockCopyButton: (props: React.ComponentProps<"button">) => <button {...props} />,
}))

// MarkdownRenderer has its own chat code-block dependency; keep that unrelated
// renderer inert while this suite exercises the raw-manifest AI Element.
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

const detail = {
  id: "p1",
  name: "Plugin One",
  version: "1.0.0",
  type: "plugin",
  description: "Test description",
  author: "Acme",
  license: "MIT",
  homepage: "https://example.com",
  repository: "https://github.com/acme/p",
  capabilities: ["tools", "themes"],
  permissions: ["clipboard:read", "shell:execute"] as PluginPermission[],
  optionalPermissions: ["network:fetch"] as PluginPermission[],
  dependencies: { "@cognia/core": "^1.0.0" },
  readme: "## Hello\nReadme body.",
  signed: true,
}

describe("PluginMarketplaceDetail", () => {
  beforeEach(() => {
    getVersionsMock.mockReset()
    getVersionsMock.mockResolvedValue([])
  })

  it("renders nothing when entry is null even if open=true", () => {
    const { container } = render(
      <PluginMarketplaceDetail
        open
        entry={null}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    // Sheet still mounts a portal, but the body content is empty.
    expect(container.textContent ?? "").toBe("")
  })

  it("renders entry metadata + install CTA", () => {
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    expect(screen.getByText("Plugin One")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("MIT")).toBeInTheDocument()
    expect(screen.getByText("install")).toBeInTheDocument()
  })

  it("install click invokes onInstall", () => {
    const onInstall = jest.fn()
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={onInstall}
        onUninstall={() => {}}
      />
    )
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("for a built-in entry, shows the Built-in badge and no install/uninstall CTA", () => {
    render(
      <PluginMarketplaceDetail
        open
        entry={{ ...detail, source: "builtin" as const }}
        installed
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    expect(screen.getAllByTestId("plugin-source-badge-builtin").length).toBeGreaterThan(0)
    expect(screen.queryByText("install")).not.toBeInTheDocument()
    expect(screen.queryByText("uninstall")).not.toBeInTheDocument()
  })

  it("when installed, uninstall click invokes onUninstall", () => {
    const onUninstall = jest.fn()
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={onUninstall}
      />
    )
    fireEvent.click(screen.getByText("uninstall"))
    expect(onUninstall).toHaveBeenCalledWith("p1")
  })

  it("renders the raw-manifest viewer with highlighted JSON when a manifest is known", () => {
    codeBlockPropsMock.mockClear()
    const manifest = { id: "p1", name: "Plugin One", version: "1.0.0" } as PluginManifest
    render(
      <PluginMarketplaceDetail
        open
        entry={{ ...detail, manifest }}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    fireEvent.click(screen.getByText("rawManifest"))
    expect(screen.getByText("rawManifestTitle")).toBeInTheDocument()
    expect(codeBlockPropsMock).toHaveBeenCalledWith(expect.objectContaining({ language: "json" }))
    expect(screen.getByText("p1.json")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument()
    expect(screen.getByTestId("manifest-code").textContent).toContain('"p1"')
  })

  it("groups registry versions inside the shadcn SelectGroup", async () => {
    getVersionsMock.mockResolvedValue([{ version: "1.1.0" }, { version: "1.0.0" }])
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )

    const picker = await screen.findByTestId("plugin-marketplace-version-picker")
    fireEvent.click(picker)
    await waitFor(() => expect(document.querySelector("[data-slot='select-group']")).not.toBeNull())
  })

  it("omits the raw-manifest viewer when no manifest is available", () => {
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    expect(screen.queryByText("rawManifest")).not.toBeInTheDocument()
  })
})
