/** @jest-environment jsdom */
import { fireEvent, render, renderHook, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import messages from "@/i18n/messages/en/externalAgent.json"

import {
  DuplicatedFromHint,
  InstanceTraitChips,
  StateIsolationBadge,
  useInstanceTraitFormatter,
  useInstanceTraitLine,
  type InstanceTrait,
} from "./instance-traits"

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ externalAgent: messages }} timeZone="UTC">
    <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
  </NextIntlClientProvider>
)

describe("useInstanceTraitFormatter", () => {
  it("translates every trait key, and says nothing for an unset value", () => {
    const { result } = renderHook(() => useInstanceTraitFormatter(), { wrapper })
    const format = result.current
    const cases: Array<[InstanceTrait, string | null]> = [
      [{ key: "permissionMode", value: "plan" }, "Plan"],
      [{ key: "permissionMode", value: null }, null],
      [{ key: "stateIsolation", value: "isolated" }, "Own state"],
      [{ key: "stateIsolation", value: "shared" }, "Shared state"],
      [{ key: "model", value: "openai/gpt-5.6" }, "Model openai/gpt-5.6"],
      [{ key: "model", value: null }, "Runtime's model"],
      [{ key: "account", value: "acct-1" }, "Bound account"],
      [{ key: "account", value: null }, "Active account"],
      [{ key: "workingDirectory", value: "/repos/app/" }, "In app"],
      [{ key: "arguments", value: "--fast" }, "Args --fast"],
      [{ key: "arguments", value: null }, "No extra args"],
      [{ key: "sandbox", value: "readOnly" }, "Read only"],
      [{ key: "network", value: "off" }, "Network off"],
      [{ key: "endpoint", value: "http://127.0.0.1:4096/v1" }, "127.0.0.1:4096"],
      [{ key: "sessionLimit", value: "2" }, "Up to 2 sessions"],
      [{ key: "approvals", value: "+Read" }, "Custom approvals"],
    ]
    for (const [trait, expected] of cases) expect(format(trait)).toBe(expected)
  })

  it("joins a bounded line for a select item", () => {
    const { result } = renderHook(() => useInstanceTraitLine(), { wrapper })
    expect(
      result.current(
        [
          { key: "permissionMode", value: "plan" },
          { key: "permissionMode", value: null },
          { key: "stateIsolation", value: "isolated" },
          { key: "sandbox", value: "readOnly" },
          { key: "network", value: "on" },
        ],
        3
      )
    ).toBe("Plan · Own state · Read only")
  })
})

describe("InstanceTraitChips", () => {
  it("renders nothing without a trait to show", () => {
    const { container } = render(<InstanceTraitChips traits={[]} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })

  it("collapses the overflow into a count", () => {
    render(
      <InstanceTraitChips
        max={1}
        traits={[
          { key: "permissionMode", value: "plan" },
          { key: "stateIsolation", value: "isolated" },
        ]}
      />,
      { wrapper }
    )
    expect(screen.getByText("Plan")).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(screen.queryByText("Own state")).not.toBeInTheDocument()
  })
})

describe("StateIsolationBadge", () => {
  it("names the state a local agent keeps, and stays out of a network agent's way", () => {
    const { rerender } = render(
      <StateIsolationBadge config={{ transport: "stdio", stateIsolation: "isolated" }} />,
      { wrapper }
    )
    expect(screen.getByTestId("state-isolation-badge")).toHaveTextContent("Own state")
    rerender(<StateIsolationBadge config={{ transport: "stdio" }} />)
    expect(screen.getByTestId("state-isolation-badge")).toHaveTextContent("Shared state")
    rerender(<StateIsolationBadge config={{ transport: "http", stateIsolation: "isolated" }} />)
    expect(screen.queryByTestId("state-isolation-badge")).not.toBeInTheDocument()
  })
})

describe("DuplicatedFromHint", () => {
  it("links back to a source that still exists", () => {
    const onOpenSource = jest.fn()
    render(<DuplicatedFromHint sourceName="Codex" onOpenSource={onOpenSource} />, { wrapper })
    fireEvent.click(screen.getByRole("button", { name: "Copy of Codex" }))
    expect(onOpenSource).toHaveBeenCalled()
  })

  it("renders nothing once the source is gone", () => {
    const { container } = render(<DuplicatedFromHint sourceName={null} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })
})
