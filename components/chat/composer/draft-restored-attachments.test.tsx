/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DraftRestoredAttachments } from "./draft-restored-attachments"

describe("<DraftRestoredAttachments />", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(<DraftRestoredAttachments items={[]} onDismiss={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists each attachment name and a formatted size", () => {
    render(
      <DraftRestoredAttachments
        items={[
          { name: "shot.png", mediaType: "image/png", size: 2048 },
          { name: "doc.pdf", mediaType: "application/pdf", size: 0 },
        ]}
        onDismiss={jest.fn()}
      />
    )
    expect(screen.getByTestId("draft-restored-attachments")).toBeInTheDocument()
    expect(screen.getByText("shot.png")).toBeInTheDocument()
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
    // 2048 bytes → "2.0 KB"; the zero-size item shows no size badge.
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument()
  })

  it("invokes onDismiss when the dismiss button is pressed", async () => {
    const onDismiss = jest.fn()
    render(
      <DraftRestoredAttachments
        items={[{ name: "a.png", mediaType: "image/png", size: 1 }]}
        onDismiss={onDismiss}
      />
    )
    await userEvent.click(screen.getByRole("button"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
