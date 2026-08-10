/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BalanceSection, type BalanceSectionProps } from "./balance-section"
import type { ResolvedProviderBalanceSource } from "@/lib/provider-diagnostics/balance"
import type { ProviderBalanceSnapshot } from "@cognia/provider-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

function source(
  overrides: Partial<ResolvedProviderBalanceSource> = {}
): ResolvedProviderBalanceSource {
  return {
    id: "src-1",
    providerId: "openai",
    kind: "official",
    label: "API key",
    primary: true,
    enabled: true,
    credentialFingerprint: "credential:openai:primary",
    query: { url: "https://api.openai.com/v1/usage" },
    ...overrides,
  } as ResolvedProviderBalanceSource
}

function snapshot(overrides: Partial<ProviderBalanceSnapshot> = {}): ProviderBalanceSnapshot {
  return {
    id: "snap-1",
    providerId: "openai",
    sourceId: "src-1",
    fetchedAt: 1_700_000_000_000,
    amounts: [{ unit: "credits", remaining: 12 }],
    ...overrides,
  } as ProviderBalanceSnapshot
}

const props: BalanceSectionProps = {
  sources: [source()],
  snapshots: [snapshot()],
  thresholds: {},
  defaultOrigin: "https://api.openai.com/v1",
  onRefresh: jest.fn(),
  onMakePrimary: jest.fn(),
  onThresholdChange: jest.fn(),
  onRemoveSource: jest.fn(),
  onSaveScript: jest.fn(async () => undefined),
}

describe("BalanceSection", () => {
  beforeEach(() => jest.clearAllMocks())

  it("shows the remaining amount per unit", () => {
    render(<BalanceSection {...props} />)
    expect(screen.getByText("12 credits")).toBeInTheDocument()
  })

  it("says so explicitly when a source has never reported", () => {
    render(<BalanceSection {...props} snapshots={[]} />)
    expect(screen.getByText("balance.noSnapshot")).toBeInTheDocument()
  })

  it("surfaces a snapshot failure instead of silently showing nothing", () => {
    render(
      <BalanceSection
        {...props}
        snapshots={[
          snapshot({
            failure: { message: "401 unauthorized" },
          } as Partial<ProviderBalanceSnapshot>),
        ]}
      />
    )
    expect(screen.getByText("401 unauthorized")).toBeInTheDocument()
  })

  it("offers 'make primary' only for a non-primary source", () => {
    const { rerender } = render(<BalanceSection {...props} />)
    expect(screen.queryByRole("button", { name: "balance.makePrimary" })).not.toBeInTheDocument()

    rerender(<BalanceSection {...props} sources={[source({ primary: false })]} />)
    fireEvent.click(screen.getByRole("button", { name: "balance.makePrimary" }))
    expect(props.onMakePrimary).toHaveBeenCalledWith("src-1")
  })

  it("allows removing only a user-authored sandbox source", () => {
    const { rerender } = render(<BalanceSection {...props} />)
    expect(screen.queryByLabelText("balance.removeSource")).not.toBeInTheDocument()

    rerender(<BalanceSection {...props} sources={[source({ kind: "sandbox-script" })]} />)
    fireEvent.click(screen.getByLabelText("balance.removeSource"))
    expect(props.onRemoveSource).toHaveBeenCalledWith("src-1")
  })

  it("refuses to refresh a source that has nothing to query", () => {
    render(
      <BalanceSection {...props} sources={[source({ kind: "unsupported", query: undefined })]} />
    )
    expect(screen.getByRole("button", { name: /balance\.refresh/ })).toBeDisabled()
  })

  it("reports threshold edits with the unit the snapshot is denominated in", () => {
    render(<BalanceSection {...props} />)
    fireEvent.change(screen.getByLabelText(/balance\.threshold/), { target: { value: "5" } })
    expect(props.onThresholdChange).toHaveBeenCalledWith("src-1", "credits", 5)
  })

  it("clears the script form — including the token — once the save resolves", async () => {
    render(<BalanceSection {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "balance.addScript" }))
    fireEvent.change(screen.getByLabelText("balance.scriptLabel"), { target: { value: "My API" } })
    fireEvent.change(screen.getByLabelText("balance.scriptToken"), { target: { value: "secret" } })
    fireEvent.change(screen.getByLabelText("balance.scriptCode"), { target: { value: "return 1" } })
    fireEvent.click(screen.getByRole("button", { name: "balance.saveScript" }))

    await waitFor(() => expect(props.onSaveScript).toHaveBeenCalled())
    expect(props.onSaveScript).toHaveBeenCalledWith(
      expect.objectContaining({ label: "My API", token: "secret", code: "return 1" })
    )
    await waitFor(() => expect(screen.getByLabelText("balance.scriptToken")).toHaveValue(""))
    expect(screen.getByLabelText("balance.scriptLabel")).toHaveValue("")
  })

  it("keeps the draft and shows the reason when the save is rejected", async () => {
    const onSaveScript = jest.fn(async () => {
      throw new Error("balance.scriptRequired")
    })
    render(<BalanceSection {...props} onSaveScript={onSaveScript} />)
    fireEvent.click(screen.getByRole("button", { name: "balance.addScript" }))
    fireEvent.change(screen.getByLabelText("balance.scriptLabel"), { target: { value: "Draft" } })
    fireEvent.click(screen.getByRole("button", { name: "balance.saveScript" }))

    expect(await screen.findByText("balance.scriptRequired")).toBeInTheDocument()
    expect(screen.getByLabelText("balance.scriptLabel")).toHaveValue("Draft")
  })

  it("locks every control for a paired client", () => {
    render(<BalanceSection {...props} readOnly sources={[source({ primary: false })]} />)
    fireEvent.click(screen.getByRole("button", { name: "balance.addScript" }))
    expect(screen.getByRole("button", { name: /balance\.refresh/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "balance.makePrimary" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "balance.saveScript" })).toBeDisabled()
    expect(screen.getByLabelText(/balance\.threshold/)).toBeDisabled()
  })
})
