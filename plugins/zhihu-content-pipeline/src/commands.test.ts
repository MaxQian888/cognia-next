import { handleZhihuCommand } from "./commands"
import { ReviewModal } from "./ui/review-modal"
import { PLUGIN_ID } from "./ids"

// The command module imports the modal, which pulls app hooks; stub it to a
// bare component so this unit test stays focused on command handling.
jest.mock("./ui/review-modal", () => ({ ReviewModal: () => null }))

afterEach(() => jest.clearAllMocks())

describe("handleZhihuCommand", () => {
  it("declines commands that aren't /zhihu", () => {
    const openModal = jest.fn()
    expect(
      handleZhihuCommand({ pluginId: PLUGIN_ID, modal: { openModal } } as never, "not-mine")
    ).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the review modal and reports success when the modal API is present", () => {
    const openModal = jest.fn()
    const message = handleZhihuCommand(
      { pluginId: PLUGIN_ID, modal: { openModal } } as never,
      "zhihu"
    )
    expect(openModal).toHaveBeenCalledWith(ReviewModal)
    expect(message).toBeTruthy()
  })

  it("degrades gracefully when no modal API is available", () => {
    const message = handleZhihuCommand({ pluginId: PLUGIN_ID } as never, "zhihu")
    // Still handled (non-null) so the host doesn't fall through to
    // "command not handled", but nothing is opened.
    expect(message).toBeTruthy()
  })
})
