/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { LabelChip } from "./label-chip"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

function lbl(p: Partial<ConversationLabelRow> = {}): ConversationLabelRow {
  return { id: "l1", name: "VIP", color: "#ff0000", sortOrder: 0, createdAt: 0, updatedAt: 0, ...p }
}

describe("LabelChip", () => {
  it("renders the label name", () => {
    render(<LabelChip label={lbl()} />)
    expect(screen.getByText("VIP")).toBeInTheDocument()
    expect(screen.getByTestId("label-chip-l1")).toBeInTheDocument()
  })

  it("renders no remove button without onRemove", () => {
    render(<LabelChip label={lbl()} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("calls onRemove when the × is clicked", () => {
    const onRemove = jest.fn()
    render(<LabelChip label={lbl()} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole("button", { name: /remove label vip/i }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it("renders without a color (no inline background style)", () => {
    render(<LabelChip label={lbl({ color: undefined })} />)
    expect(screen.getByText("VIP")).toBeInTheDocument()
  })
})
