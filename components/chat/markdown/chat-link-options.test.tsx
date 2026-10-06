import { render, screen } from "@testing-library/react"
import { DEFAULT_MESSAGE_LINK_OPTIONS } from "@/lib/chat/message-display"
import { ChatLinkOptionsProvider, useChatLinkOptions } from "./chat-link-options"

function Probe() {
  const options = useChatLinkOptions()
  return <output>{JSON.stringify(options)}</output>
}

describe("ChatLinkOptionsProvider", () => {
  it("falls back to the defaults without a provider", () => {
    render(<Probe />)
    expect(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify(DEFAULT_MESSAGE_LINK_OPTIONS)
    )
  })

  it("hands the provided options to descendants", () => {
    const value = { color: "text", underline: "hover", siteIcon: false, preview: "off" } as const
    render(
      <ChatLinkOptionsProvider value={value}>
        <Probe />
      </ChatLinkOptionsProvider>
    )
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify(value))
  })
})
