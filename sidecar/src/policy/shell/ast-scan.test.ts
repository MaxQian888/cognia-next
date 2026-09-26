import { test } from "node:test"
import assert from "node:assert/strict"

import { findDangerousShellFragment } from "./ast-scan.ts"

test("findDangerousShellFragment uses shell structure instead of matching quoted text", () => {
  assert.equal(findDangerousShellFragment("printf ok >/dev/null"), null)
  assert.equal(findDangerousShellFragment("echo '>/dev/sda && rm -rf /'"), null)
  assert.match(findDangerousShellFragment("printf bad >/dev/sda")?.fragment ?? "", />\/dev\/sda/)
  assert.match(findDangerousShellFragment("echo $(rm -rf /)")?.fragment ?? "", /rm/)
})
