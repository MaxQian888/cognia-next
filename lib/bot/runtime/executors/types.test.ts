import { BotExecutorUnavailableError } from "./types"

describe("BotExecutorUnavailableError", () => {
  it("names the executor that could not run", () => {
    const error = new BotExecutorUnavailableError("agent-turn", "no working directory")
    expect(error.executor).toBe("agent-turn")
    expect(error.name).toBe("BotExecutorUnavailableError")
    expect(error.message).toBe("no working directory")
  })

  it("is an Error, so an executor may simply throw it", () => {
    // The run driver branches on `instanceof`, which is what separates
    // "nothing could run" from "the work ran and failed".
    expect(new BotExecutorUnavailableError("handler", "x")).toBeInstanceOf(Error)
  })
})
