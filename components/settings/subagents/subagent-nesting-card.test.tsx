/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

import {
  NESTING_DEFAULTS,
  SubagentNestingCard,
  nestingValuesFromSettings,
  nestingValuesToSettings,
  type NestingPolicyValues,
} from "./subagent-nesting-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function Controlled({ initial = NESTING_DEFAULTS }: { initial?: NestingPolicyValues }) {
  const [value, setValue] = useState(initial)
  return (
    <SubagentNestingCard
      value={value}
      onChange={(partial) => setValue((v) => ({ ...v, ...partial }))}
    />
  )
}

describe("nestingValuesFromSettings", () => {
  it("falls back to defaults when the branch is absent", () => {
    expect(nestingValuesFromSettings(undefined)).toEqual(NESTING_DEFAULTS)
    expect(nestingValuesFromSettings({} as AppSettings)).toEqual(NESTING_DEFAULTS)
  })

  it("converts the stored timeout from ms to display seconds", () => {
    const values = nestingValuesFromSettings({
      subagentNesting: { enabled: true, maxDepth: 3, timeoutMs: 90_000 },
    } as AppSettings)
    expect(values.timeoutSeconds).toBe(90)
    expect(values.enabled).toBe(true)
    expect(values.maxDepth).toBe(3)
  })
})

describe("nestingValuesToSettings", () => {
  it("converts display seconds back to ms", () => {
    expect(nestingValuesToSettings({ ...NESTING_DEFAULTS, timeoutSeconds: 90 }).timeoutMs).toBe(
      90_000
    )
  })

  it("normalises the two 'unlimited' dials to 0 rather than a negative", () => {
    const out = nestingValuesToSettings({
      ...NESTING_DEFAULTS,
      tokenBudget: -5,
      timeoutSeconds: -5,
    })
    expect(out.tokenBudget).toBe(0)
    expect(out.timeoutMs).toBe(0)
  })

  it("round-trips through the settings shape", () => {
    const values: NestingPolicyValues = {
      enabled: true,
      maxDepth: 4,
      tokenBudget: 50_000,
      timeoutSeconds: 120,
      dispatchMaxRetries: 3,
    }
    expect(
      nestingValuesFromSettings({
        subagentNesting: nestingValuesToSettings(values),
      } as AppSettings)
    ).toEqual(values)
  })
})

describe("SubagentNestingCard", () => {
  it("keeps the finder deep-link anchor", () => {
    const { container } = render(<Controlled />)
    expect(container.querySelector('[data-setting-id="subagent-nesting"]')).toBeInTheDocument()
  })

  it("reports edits upward instead of holding its own state", async () => {
    const onChange = jest.fn()
    render(<SubagentNestingCard value={NESTING_DEFAULTS} onChange={onChange} />)
    await userEvent.click(screen.getByRole("switch", { name: "enabled" }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true })
  })

  it("gates the subtree dials behind the master switch", async () => {
    render(<Controlled />)
    expect(screen.getByLabelText("maxDepth")).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "enabled" }))
    expect(screen.getByLabelText("maxDepth")).toBeEnabled()
  })

  it("leaves the retry dial reachable while nesting is off — it also governs depth-1", () => {
    render(<Controlled />)
    expect(screen.getByLabelText("dispatchMaxRetries")).toBeEnabled()
  })

  it("clamps out-of-range depth to the supported ceiling", async () => {
    render(<Controlled initial={{ ...NESTING_DEFAULTS, enabled: true }} />)
    const depth = screen.getByLabelText("maxDepth")
    await userEvent.clear(depth)
    await userEvent.type(depth, "99")
    expect(depth).toHaveValue(5)
  })
})
