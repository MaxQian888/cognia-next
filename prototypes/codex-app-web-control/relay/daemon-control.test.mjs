import assert from "node:assert/strict"
import test from "node:test"

import { sharedRuntimeLabels } from "./daemon-control.mjs"

test("shared runtime launchd labels are stable and user-scoped", () => {
  assert.deepEqual(sharedRuntimeLabels(501), {
    daemon: "com.cognia.codex-shared-runtime-poc.daemon.501",
    relaunch: "com.cognia.codex-shared-runtime-poc.relaunch.501",
    rollback: "com.cognia.codex-shared-runtime-poc.rollback.501",
  })
})
