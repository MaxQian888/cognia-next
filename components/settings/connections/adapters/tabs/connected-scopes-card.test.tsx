/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { ConnectedScopesCard } from "./connected-scopes-card"

function row(settings: Record<string, unknown>): AdapterInstanceRow {
  return { id: "a1", type: "slack", settings } as unknown as AdapterInstanceRow
}

describe("ConnectedScopesCard", () => {
  it("renders nothing when no scopes were recorded", () => {
    const { container } = render(<ConnectedScopesCard row={row({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the recorded scope list is empty", () => {
    const { container } = render(
      <ConnectedScopesCard row={row({ connectedScopes: { scopes: [], grantedAtMs: 1 } })} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("lists the granted scopes when present", () => {
    render(
      <ConnectedScopesCard
        row={row({ connectedScopes: { scopes: ["channels:read", "chat:write"], grantedAtMs: 1 } })}
      />
    )
    expect(screen.getByTestId("connected-scopes-card")).toBeInTheDocument()
    expect(screen.getByText("channels:read")).toBeInTheDocument()
    expect(screen.getByText("chat:write")).toBeInTheDocument()
  })
})
