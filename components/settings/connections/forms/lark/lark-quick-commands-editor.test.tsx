/**
 * @jest-environment jsdom
 *
 * Thin wrapper test — the shared editor at
 * `components/settings/connections/forms/_shared/quick-commands-editor.test.tsx`
 * exercises the full add/remove/duplicate matrix. This file only asserts
 * that the Lark wrapper passes through to the shared editor with the
 * adapter-specific help paragraph + a stable `lqc-` test id prefix so
 * the Lark config dialog can still target its instance.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { LarkQuickCommandsEditor } from "./lark-quick-commands-editor"
import type { IMQuickCommand } from "@/lib/connectors/quick-commands"

function setup(value: IMQuickCommand[] = []) {
  const onChange = jest.fn<void, [IMQuickCommand[]]>()
  render(<LarkQuickCommandsEditor value={value} onChange={onChange} />)
  return { onChange }
}

describe("LarkQuickCommandsEditor", () => {
  it("renders the shared editor with the Lark-specific help text", () => {
    setup()
    expect(screen.getByTestId("lqc-editor")).toBeInTheDocument()
    // The help paragraph references the Feishu console — proves we're
    // sourcing the Lark-specific i18n key, not the shared default.
    const help = screen.getByText(/Lark console/i)
    expect(help).toBeInTheDocument()
  })

  it("forwards add events as canonical IMQuickCommand rows with triggerKey", () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByTestId("lqc-trigger-key"), { target: { value: "agenda" } })
    fireEvent.change(screen.getByTestId("lqc-value"), { target: { value: "/agenda today" } })
    fireEvent.click(screen.getByTestId("lqc-add"))
    expect(onChange).toHaveBeenCalledWith([
      { triggerKey: "agenda", action: { type: "prompt", value: "/agenda today" } },
    ])
  })

  it("forwards remove events without re-shaping the row", () => {
    const existing: IMQuickCommand[] = [
      { triggerKey: "a", action: { type: "prompt", value: "pa" } },
      { triggerKey: "b", action: { type: "slash", value: "/pb" } },
    ]
    const { onChange } = setup(existing)
    fireEvent.click(screen.getByTestId("lqc-remove-a"))
    expect(onChange).toHaveBeenCalledWith([
      { triggerKey: "b", action: { type: "slash", value: "/pb" } },
    ])
  })
})
