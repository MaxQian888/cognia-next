/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginMarketplaceCard } from "./plugin-marketplace-card"

const baseEntry = {
  id: "p1",
  name: "Plugin One",
  version: "1.0.0",
  description: "Test plugin",
  author: "Acme",
  rating: 4.5,
  downloads: 1234,
  signed: true,
  type: "plugin",
  capabilities: ["tools", "themes", "commands", "hooks"],
  permissions: ["clipboard:read"],
}

const callbacks = () => ({
  onView: jest.fn(),
  onInstall: jest.fn(),
  onUninstall: jest.fn(),
})

describe("PluginMarketplaceCard", () => {
  it("renders core metadata", () => {
    const cb = callbacks()
    const { container } = render(
      <PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />
    )
    expect(screen.getByText("Plugin One")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("Acme")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-content']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-footer']")).not.toBeNull()
  })

  it("install button invokes onInstall with id + version", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    fireEvent.click(screen.getByText("install"))
    expect(cb.onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("clicking the title invokes onView", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    fireEvent.click(screen.getByText("Plugin One"))
    expect(cb.onView).toHaveBeenCalledWith("p1")
  })

  it("when installed, shows an uninstall button", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed installing={false} {...cb} />)
    fireEvent.click(screen.getByText("uninstall"))
    expect(cb.onUninstall).toHaveBeenCalledWith("p1")
  })

  it("highlights dangerous permissions", () => {
    const cb = callbacks()
    render(
      <PluginMarketplaceCard
        entry={{ ...baseEntry, permissions: ["shell:execute"] }}
        installed={false}
        installing={false}
        {...cb}
      />
    )
    expect(screen.getByText("dangerous")).toBeInTheDocument()
  })

  it("for a built-in entry, shows the Built-in badge and no install/uninstall button", () => {
    const cb = callbacks()
    render(
      <PluginMarketplaceCard
        entry={{ ...baseEntry, source: "builtin" as const }}
        installed
        installing={false}
        {...cb}
      />
    )
    expect(screen.getByTestId("plugin-source-badge-builtin")).toBeInTheDocument()
    expect(screen.queryByText("install")).not.toBeInTheDocument()
    expect(screen.queryByText("uninstall")).not.toBeInTheDocument()
  })

  describe("Open VSX badges", () => {
    it("checksum_badge_does_not_claim_publisher_verification", () => {
      // The failure this guards: mapping Open VSX's `verified` onto `signed`
      // makes the card render a ShieldCheck labelled "Verified" whose tooltip
      // says "Publisher signature verified." We verify no signature — only a
      // SHA-256 fetched over the same TLS connection, from the same host, as
      // the .vsix. So the integrity badge must scope itself to transit and
      // must not borrow the signature badge's language.
      const cb = callbacks()
      const { container } = render(
        <PluginMarketplaceCard
          entry={{
            ...baseEntry,
            signed: undefined,
            signatureState: "unknown" as const,
            type: "vscode-extension",
          }}
          installed
          installing={false}
          integrityChecked
          {...cb}
        />
      )

      // The integrity badge exists and says what it means.
      expect(screen.getByTestId("plugin-openvsx-integrity-p1")).toHaveTextContent(
        "integrityChecked"
      )
      // ...and the signature badge stays "unknown". The badge is `compact`
      // (icon only), so the state is only observable through which icon it
      // picked: ShieldCheck is the "signature verified" visual and must not
      // appear for a checksum.
      expect(container.querySelector(".lucide-shield-off")).not.toBeNull()
      expect(container.querySelector(".lucide-shield-check")).toBeNull()
      // No unattributed publisher claim rode along with the checksum.
      expect(screen.queryByTestId("plugin-openvsx-verified-p1")).not.toBeInTheDocument()
    })

    it("does not render an integrity badge before anything has been checked", () => {
      // Pre-install nothing has been verified; a badge would claim work we
      // haven't done.
      const cb = callbacks()
      render(
        <PluginMarketplaceCard
          entry={{ ...baseEntry, signed: undefined }}
          installed={false}
          installing={false}
          {...cb}
        />
      )
      expect(screen.queryByTestId("plugin-openvsx-integrity-p1")).not.toBeInTheDocument()
    })

    it("verified_badge_is_attributed_to_open_vsx", () => {
      const cb = callbacks()
      const { container } = render(
        <PluginMarketplaceCard
          entry={{ ...baseEntry, signed: undefined, signatureState: "unknown" as const }}
          installed={false}
          installing={false}
          verifiedPublisher
          {...cb}
        />
      )

      // The attribution lives in the label itself, not in a tooltip the user
      // may never open: the key is `publisherVerified`, whose message in both
      // locales names Open VSX ("Publisher verified by Open VSX" /
      // "发布者由 Open VSX 验证"). The next assertion is what stops that key from
      // being swapped for a bare "verified" — the i18n mock returns keys, and
      // the messages themselves are pinned by lint:i18n parity.
      const badge = screen.getByTestId("plugin-openvsx-verified-p1")
      expect(badge).toHaveTextContent("publisherVerified")
      expect(badge).not.toHaveTextContent(/^verified$/)

      // A publisher claim must never imply a signature check.
      expect(container.querySelector(".lucide-shield-check")).toBeNull()
    })

    it("renders the unsupported-API warning so it survives past install", () => {
      const cb = callbacks()
      render(
        <PluginMarketplaceCard
          entry={baseEntry}
          installed
          installing={false}
          unsupportedApis={["vscode.debug"]}
          {...cb}
        />
      )
      expect(screen.getByTestId("plugin-openvsx-unsupported-p1")).toBeInTheDocument()
    })

    it("renders no Open VSX badges at all when the props are absent", () => {
      // The additive-prop contract: a cognia-registry entry renders exactly as
      // it did before these props existed.
      const cb = callbacks()
      const { container } = render(
        <PluginMarketplaceCard entry={baseEntry} installed installing={false} {...cb} />
      )
      expect(screen.queryByTestId("plugin-openvsx-verified-p1")).not.toBeInTheDocument()
      expect(screen.queryByTestId("plugin-openvsx-integrity-p1")).not.toBeInTheDocument()
      expect(screen.queryByTestId("plugin-openvsx-unsupported-p1")).not.toBeInTheDocument()
      // ...and `signed: true` still maps to the signature badge exactly as it
      // did for cognia entries — the props are additive, not a rewrite.
      expect(container.querySelector(".lucide-shield-check")).not.toBeNull()
    })

    it("an empty unsupportedApis list renders no warning", () => {
      const cb = callbacks()
      render(
        <PluginMarketplaceCard
          entry={baseEntry}
          installed
          installing={false}
          unsupportedApis={[]}
          {...cb}
        />
      )
      expect(screen.queryByTestId("plugin-openvsx-unsupported-p1")).not.toBeInTheDocument()
    })
  })

  it("renders the click-card region with the shadcn Button primitive", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    const region = screen.getByText("Plugin One").closest("button")
    expect(region).not.toBeNull()
    expect(region).toHaveAttribute("type", "button")
    expect(region).toHaveAttribute("data-slot", "button")
  })
})
