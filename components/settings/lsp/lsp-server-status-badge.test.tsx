import { render, screen } from "@testing-library/react"
import { LspServerStatusBadge } from "./lsp-server-status-badge"
import type { LspServerStatus } from "@/types/lsp/config"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function status(extra: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    serverId: "typescript",
    install: "installed",
    health: "stopped",
    restarts: 0,
    ...extra,
  }
}

describe("LspServerStatusBadge", () => {
  it("renders nothing without a status (web/mobile)", () => {
    const { container } = render(<LspServerStatusBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the install state; health hidden while stopped", () => {
    render(<LspServerStatusBadge status={status()} />)
    expect(screen.getByText("status.installed")).toBeInTheDocument()
    expect(screen.queryByText("health.stopped")).not.toBeInTheDocument()
  })

  it("marks a missing binary as destructive", () => {
    render(<LspServerStatusBadge status={status({ install: "missing" })} />)
    expect(screen.getByText("status.missing")).toBeInTheDocument()
  })

  it("shows runtime health with restart count", () => {
    render(<LspServerStatusBadge status={status({ health: "crashed", restarts: 2 })} />)
    expect(screen.getByText("health.crashed ×2")).toBeInTheDocument()
  })

  it("shows broken state", () => {
    render(
      <LspServerStatusBadge status={status({ health: "broken", restarts: 4, lastError: "x" })} />
    )
    expect(screen.getByText("health.broken ×4")).toBeInTheDocument()
  })

  it("replaces the detection badge with the install phase while installing", () => {
    render(
      <LspServerStatusBadge
        status={status({ install: "missing" })}
        progress={{ serverId: "typescript", phase: "installing" }}
      />
    )
    expect(screen.getByText("install.phase.installing")).toBeInTheDocument()
    expect(screen.queryByText("status.missing")).not.toBeInTheDocument()
  })
})
