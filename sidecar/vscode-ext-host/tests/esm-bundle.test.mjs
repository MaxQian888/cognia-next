// An ES module extension is refused at load with the reason, as the plugin
// detail's compatibility section (`esm-bundle`) already told the user.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { FIXTURES, startHost } from "./host-harness.mjs"

test("an ES module bundle is refused with the reason", async () => {
  const id = "cognia.hello-extension"
  const host = startHost(id)
  try {
    await assert.rejects(
      host.request("extension:load", {
        extensionId: id,
        extensionPath: join(FIXTURES, "hello-extension"),
        main: "./out/extension.js",
        bundleFormat: "esm",
        grantedModules: [],
      }),
      {
        message:
          'Extension "cognia.hello-extension" is an ES module. Cognia\'s extension host, like VS Code 1.91, loads extensions as CommonJS, so it cannot start.',
      }
    )
  } finally {
    host.stop()
  }
})
