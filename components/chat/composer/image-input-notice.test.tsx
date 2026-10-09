import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ImageInputNotice } from "./image-input-notice"

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

describe("ImageInputNotice", () => {
  it.each([
    [
      { accepted: false, reason: "agent-no-images", agentName: "Cline" } as const,
      "Cline can't see images",
      /^Cline reads text only/,
    ],
    [
      { accepted: false, reason: "agent-no-images", agentName: null } as const,
      "This agent can't see images",
      /^This agent reads text only/,
    ],
    [
      { accepted: false, reason: "host-outdated", agentName: "Codex" } as const,
      "Host can't take images",
      /Update Cognia on the Host/,
    ],
    [
      {
        accepted: false,
        reason: "model-no-vision",
        modelName: "DeepSeek V4 Pro",
        agentName: "Pi",
      } as const,
      "DeepSeek V4 Pro can't see images",
      /Switch Pi to a model with vision in the model menu/,
    ],
    [
      {
        accepted: false,
        reason: "model-no-vision",
        modelName: "DeepSeek V4 Pro",
        agentName: null,
      } as const,
      "DeepSeek V4 Pro can't see images",
      /^DeepSeek V4 Pro doesn't accept images/,
    ],
  ])("names %o in a few words, and why in full", (verdict, short, full) => {
    render(
      <ImageInputNotice verdict={verdict} count={2} imageCount={2} imagesWithoutText={["a", "b"]} />
    )
    const pill = screen.getByTestId("attachment-visual-notice")
    expect(pill).toHaveTextContent(short)
    expect(pill.getAttribute("aria-label")).toMatch(full)
  })

  it("opens to the remedy and extracts the text of the images still missing it", async () => {
    let finish: () => void = () => {}
    const onExtractImageText = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(
      <ImageInputNotice
        verdict={{ accepted: false, reason: "agent-no-images", agentName: "Pi" }}
        count={3}
        imageCount={2}
        imagesWithoutText={["a", "b"]}
        onExtractImageText={onExtractImageText}
      />
    )
    await user().click(screen.getByTestId("attachment-visual-notice"))
    const action = await screen.findByTestId("attachment-visual-notice-extract")
    expect(action).toHaveTextContent("Send the text in these 2 images instead")
    await user().click(action)
    expect(onExtractImageText).toHaveBeenCalledWith(["a", "b"])
    // Busy while the OCR runs, so a second click cannot start it twice.
    expect(screen.getByTestId("attachment-visual-notice-extract")).toBeDisabled()
    expect(screen.getByTestId("attachment-visual-notice-extract")).toHaveTextContent(
      "Extracting text…"
    )
    finish()
    expect(await screen.findByText("Send the text in these 2 images instead")).toBeInTheDocument()
  })

  it("marks the pill and says the text goes once every image has it", async () => {
    render(
      <ImageInputNotice
        verdict={{ accepted: false, reason: "agent-no-images", agentName: "Pi" }}
        count={1}
        imageCount={1}
        imagesWithoutText={[]}
        onExtractImageText={jest.fn()}
      />
    )
    const pill = screen.getByTestId("attachment-visual-notice")
    expect(pill).toHaveAttribute("data-text-included", "true")
    await user().click(pill)
    expect(await screen.findByTestId("attachment-visual-notice-text-included")).toHaveTextContent(
      "The text in this image will be sent."
    )
  })

  it("offers no text action for a video alone, or without a handler", async () => {
    const { rerender } = render(
      <ImageInputNotice
        verdict={{ accepted: false, reason: "agent-no-images", agentName: "Pi" }}
        count={1}
        imageCount={0}
        imagesWithoutText={[]}
        onExtractImageText={jest.fn()}
      />
    )
    expect(screen.getByTestId("attachment-visual-notice")).not.toHaveAttribute("data-text-included")
    await user().click(screen.getByTestId("attachment-visual-notice"))
    expect(await screen.findByTestId("attachment-visual-notice-detail")).toBeInTheDocument()
    expect(screen.queryByTestId("attachment-visual-notice-extract")).toBeNull()
    rerender(
      <ImageInputNotice
        verdict={{ accepted: false, reason: "agent-no-images", agentName: "Pi" }}
        count={1}
        imageCount={1}
        imagesWithoutText={["a"]}
      />
    )
    expect(screen.queryByTestId("attachment-visual-notice-extract")).toBeNull()
  })
})
