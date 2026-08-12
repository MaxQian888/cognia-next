import assert from "node:assert/strict"
import test from "node:test"

import { buildCdpWebService, cdpWebLabel } from "./cdp-web-service.mjs"

test("CDP Web service is user-scoped and launched independently through launchd", () => {
  assert.equal(cdpWebLabel(501), "com.cognia.codex-cdp-web-poc.501")
  const service = buildCdpWebService({
    launchId: "launch-123",
    stateDir: "/tmp/cognia-test",
    forwardedArgs: ["--workspace", "/Users/example/project"],
    label: "com.cognia.test-web",
  })

  assert.deepEqual(service.launchArgs.slice(0, 5), [
    "submit",
    "-l",
    "com.cognia.test-web",
    "-o",
    "/tmp/cognia-test/cdp-web.stdout.log",
  ])
  assert.ok(service.launchArgs.some((argument) => argument.endsWith("cdp-web.mjs")))
  assert.deepEqual(service.launchArgs.slice(-6), [
    "--launch-id",
    "launch-123",
    "--state-dir",
    "/tmp/cognia-test",
    "--workspace",
    "/Users/example/project",
  ])
})
