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
      handleZhihuCommand({ modal: { openModal }, i18n: { t: jest.fn() } } as never, "not-mine")
    ).toBeNull()
    expect(openModal).not.toHaveBeenCalled()
  })

  it("opens the review modal at the host's large size and answers via ctx.i18n.t", () => {
    const openModal = jest.fn()
    const t = jest.fn(() => "OPENED")
    const result = handleZhihuCommand({ modal: { openModal }, i18n: { t } } as never, "zhihu")
    // The body sets no width; the host dialog sizes it, so it cannot overflow.
    expect(openModal).toHaveBeenCalledWith(ReviewModal, undefined, { size: "lg" })
    expect(t).toHaveBeenCalledWith("command.opened")
    expect(result).toEqual({ handled: true, message: "OPENED" })
  })

  it("keeps the plugin id it was registered under", () => {
    expect(PLUGIN_ID).toBe("zhihu-content-pipeline")
  })
})
