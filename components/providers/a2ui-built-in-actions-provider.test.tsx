/** @jest-environment jsdom */
import { render } from "@testing-library/react"
import { toast } from "sonner"
import { A2UIBuiltInActionsProvider } from "./a2ui-built-in-actions-provider"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import {
  __resetA2UIChatBindingsForTesting,
  bindA2UISurfaceToChat,
} from "@/lib/a2ui/chat-action-routing"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIUserAction } from "@/types/a2ui/schema"

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: jest.fn(() => ({})),
}))
jest.mock("@/hooks/chat/chat-send-bridge", () => ({ sendChatMessage: jest.fn(() => true) }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

function installedOnAction(): (action: A2UIUserAction) => void {
  const options = (useA2UIAppBuilder as jest.Mock).mock.calls.at(-1)?.[0]
  return options.onAction
}

function click(componentId = "go"): A2UIUserAction {
  return {
    type: "userAction",
    surfaceId: "trip",
    componentId,
    action: "search_hotels",
    data: { text: "Search" },
    timestamp: 0,
  }
}

describe("A2UIBuiltInActionsProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetA2UIChatBindingsForTesting()
    useA2UIStore.getState().reset()
    useA2UIStore.getState().processMessages([
      { type: "createSurface", surfaceId: "trip", surfaceType: "inline" },
      {
        type: "updateComponents",
        surfaceId: "trip",
        components: [
          { id: "root", component: "Column", children: ["go"] },
          { id: "go", component: "Button", text: "Search", action: "search_hotels" },
        ],
      },
    ])
  })

  it("opts the builder into global built-in action handling with the chat router", () => {
    render(<A2UIBuiltInActionsProvider />)
    expect(useA2UIAppBuilder).toHaveBeenCalledWith({
      wireBuiltInActions: true,
      onAction: expect.any(Function),
    })
  })

  it("renders nothing", () => {
    const { container } = render(<A2UIBuiltInActionsProvider />)
    expect(container).toBeEmptyDOMElement()
  })

  it("sends an unhandled gesture on a chat-bound surface to its session", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    render(<A2UIBuiltInActionsProvider />)
    installedOnAction()(click())
    expect(sendChatMessage).toHaveBeenCalledWith("s1", expect.stringMatching(/^Search\n/))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("keeps unbound surfaces local", () => {
    render(<A2UIBuiltInActionsProvider />)
    installedOnAction()(click())
    expect(sendChatMessage).not.toHaveBeenCalled()
  })

  it("tells the user when the chat could not take the message", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    ;(sendChatMessage as jest.Mock).mockReturnValueOnce(false)
    render(<A2UIBuiltInActionsProvider />)
    installedOnAction()(click())
    expect(toast.error).toHaveBeenCalledWith("Couldn't send this action to the conversation")
  })
})
