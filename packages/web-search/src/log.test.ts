import { log } from "./log"

describe("log", () => {
  let warnSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let infoSpy: jest.SpyInstance
  let debugSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {})
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    infoSpy.mockRestore()
    debugSpy.mockRestore()
  })

  describe("warn", () => {
    it("logs warn with prefix and meta when meta provided", () => {
      log.warn("hello", { a: 1 })
      expect(warnSpy).toHaveBeenCalledWith("[search] hello", { a: 1 })
    })

    it("logs warn with prefix only when meta omitted", () => {
      log.warn("simple")
      expect(warnSpy).toHaveBeenCalledWith("[search] simple")
    })
  })

  describe("error", () => {
    it("logs error with prefix and meta when meta provided", () => {
      log.error("boom", new Error("x"))
      expect(errorSpy).toHaveBeenCalledWith("[search] boom", expect.any(Error))
    })

    it("logs error with prefix only when meta omitted", () => {
      log.error("noinfo")
      expect(errorSpy).toHaveBeenCalledWith("[search] noinfo")
    })
  })

  describe("info", () => {
    it("logs info with prefix and meta when meta provided", () => {
      log.info("hi", "data")
      expect(infoSpy).toHaveBeenCalledWith("[search] hi", "data")
    })

    it("logs info with prefix only when meta omitted", () => {
      log.info("plain")
      expect(infoSpy).toHaveBeenCalledWith("[search] plain")
    })
  })

  describe("debug", () => {
    it("logs debug with prefix and meta when meta provided", () => {
      log.debug("dbg", 42)
      expect(debugSpy).toHaveBeenCalledWith("[search] dbg", 42)
    })

    it("logs debug with prefix only when meta omitted", () => {
      log.debug("plain")
      expect(debugSpy).toHaveBeenCalledWith("[search] plain")
    })
  })
})
