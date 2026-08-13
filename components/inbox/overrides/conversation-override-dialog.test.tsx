/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ConversationOverrideDialog } from "./conversation-override-dialog"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("ConversationOverrideDialog", () => {
  it("renders the form when open", () => {
    render(
      <ConversationOverrideDialog
        open={true}
        onOpenChange={() => {}}
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_x"
        sessionId="s_x"
      />
    )
    expect(screen.getByTestId("conv-override-save")).toBeInTheDocument()
    expect(screen.getByText("lark:lark-1:oc_x")).toBeInTheDocument()
    expect(screen.getAllByText(/Effective source:/i)).toHaveLength(4)
  })

  it("does not render the form when closed", () => {
    render(
      <ConversationOverrideDialog
        open={false}
        onOpenChange={() => {}}
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_x"
        sessionId="s_x"
      />
    )
    expect(screen.queryByTestId("conv-override-save")).not.toBeInTheDocument()
  })
})
