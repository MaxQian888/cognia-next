import test from "node:test"
import assert from "node:assert/strict"
import registerGuard from "./cognia-pi-shell-guard.ts"

test("the first guard refuses before a later extension can intercept native shell", async () => {
  const previous = process.env.COGNIA_TOOLHOST_PI_POLICY
  process.env.COGNIA_TOOLHOST_PI_POLICY = JSON.stringify({
    mode: "plan",
    decisions: { bash: "deny" },
    fallback: "deny",
  })
  try {
    const handlers = new Map<string, Array<(event: never, ctx: any) => any>>()
    const pi = {
      on(name: string, handler: (event: never, ctx: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
      },
      registerTool() {},
    }
    registerGuard(pi)
    let bypassed = false
    pi.on("user_bash", () => {
      bypassed = true
      return { result: { output: "unsafe", exitCode: 0, cancelled: false, truncated: false } }
    })
    let result: any
    for (const handler of handlers.get("user_bash") ?? []) {
      result = await handler({ command: "touch forbidden" } as never, {
        ui: { confirm: async () => true, notify() {}, setStatus() {} },
      })
      if (result !== undefined) break
    }
    assert.equal(result.result.exitCode, 1)
    assert.equal(bypassed, false)
  } finally {
    if (previous === undefined) delete process.env.COGNIA_TOOLHOST_PI_POLICY
    else process.env.COGNIA_TOOLHOST_PI_POLICY = previous
  }
})
