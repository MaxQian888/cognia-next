import { SILENT_AGENT_LOGGER } from "./host"

describe("SILENT_AGENT_LOGGER", () => {
  it("accepts every level without output and cannot be replaced", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {})
    try {
      SILENT_AGENT_LOGGER.debug("d", { a: 1 })
      SILENT_AGENT_LOGGER.info("i")
      SILENT_AGENT_LOGGER.warn("w")
      SILENT_AGENT_LOGGER.error("e")
      expect(spy).not.toHaveBeenCalled()
      expect(Object.isFrozen(SILENT_AGENT_LOGGER)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
