import { test } from "node:test"
import assert from "node:assert/strict"
import Module from "node:module"

const { installRequireHook, setExtensionResolver, setGrantedModules, uninstallRequireHook } =
  await import("../dist/require-hook.js")

function taggedParent(extensionId) {
  const parent = new Module(`/tmp/${extensionId}/extension.js`)
  parent.cogniaExtensionId = extensionId
  return parent
}

test("sensitive CommonJS imports fail closed without blocking the event loop", () => {
  setExtensionResolver((parent) => parent?.cogniaExtensionId ?? null)
  installRequireHook()
  try {
    const startedAt = Date.now()
    assert.throws(
      () => Module._load("fs", taggedParent("publisher.denied"), false),
      (error) => error?.code === "EPERM"
    )
    assert.ok(Date.now() - startedAt < 100, "denial must be synchronous, not a 30s timeout")
  } finally {
    uninstallRequireHook()
  }
})

test("pre-authorized sensitive modules load synchronously and remain extension-scoped", () => {
  setExtensionResolver((parent) => parent?.cogniaExtensionId ?? null)
  setGrantedModules("publisher.allowed", ["fs"])
  installRequireHook()
  try {
    assert.equal(
      typeof Module._load("fs", taggedParent("publisher.allowed"), false).readFile,
      "function"
    )
    assert.throws(
      () => Module._load("fs", taggedParent("publisher.other"), false),
      (error) => error?.code === "EPERM"
    )
  } finally {
    uninstallRequireHook()
  }
})
