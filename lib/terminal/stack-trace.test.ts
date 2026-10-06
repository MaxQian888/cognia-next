import { parseStackTrace } from "./stack-trace"
import { parseStackTrace as parsePackageStackTrace } from "@cognia/error-parsers/stack-trace"

it("keeps terminal stack parsing on the shared package implementation", () => {
  expect(parseStackTrace).toBe(parsePackageStackTrace)
  expect(parseStackTrace("    at handler (/app/server.js:42:9)")).toEqual([
    { fn: "handler", file: "/app/server.js", line: 42, col: 9 },
  ])
})
