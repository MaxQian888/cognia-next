import * as host from "./index"
import packageJson from "../../package.json"

it("keeps host compatibility callable only inside the monorepo", () => {
  expect(typeof host.runPkceAuthFlow).toBe("function")
  expect(typeof host.createPiiRedactionGate).toBe("function")
  expect((packageJson.exports as Record<string, unknown>)["./host"]).toBeUndefined()
})
