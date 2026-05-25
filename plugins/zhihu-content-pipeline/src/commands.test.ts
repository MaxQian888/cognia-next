import { registerSlashCommand } from "@/lib/chat/slash-command-registry"
import { registerZhihuCommands } from "./commands"
import { ReviewModal } from "./ui/review-modal"
import { PLUGIN_ID } from "./ids"

jest.mock("@/lib/chat/slash-command-registry", () => ({ registerSlashCommand: jest.fn() }))
// The command module imports the modal, which pulls app hooks; stub it to a
// bare component so this unit test stays focused on command registration.
jest.mock("./ui/review-modal", () => ({ ReviewModal: () => null }))

const mockRegister = registerSlashCommand as jest.Mock

afterEach(() => jest.clearAllMocks())

describe("registerZhihuCommands", () => {
  it("registers the /zhihu plugin command", () => {
    registerZhihuCommands({ pluginId: PLUGIN_ID, modal: { openModal: jest.fn() } } as never)
    expect(mockRegister).toHaveBeenCalledTimes(1)
    const def = mockRegister.mock.calls[0][0]
    expect(def).toMatchObject({
      id: "zhihu",
      name: "/zhihu",
      source: "plugin",
      pluginId: PLUGIN_ID,
    })
  })

  it("opens the review modal and reports success when modal API is present", async () => {
    const openModal = jest.fn()
    registerZhihuCommands({ pluginId: PLUGIN_ID, modal: { openModal } } as never)
    const def = mockRegister.mock.calls[0][0]
    const result = await def.handler("")
    expect(openModal).toHaveBeenCalledWith(ReviewModal)
    expect(result.message).toContain("审阅面板")
  })

  it("degrades gracefully when no modal API is available", async () => {
    registerZhihuCommands({ pluginId: PLUGIN_ID } as never)
    const def = mockRegister.mock.calls[0][0]
    const result = await def.handler("")
    expect(result.message).toContain("不支持")
  })
})
