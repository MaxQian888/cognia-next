import assert from "node:assert/strict"
import test from "node:test"

import { createManagedStorageFacade } from "../src/managed-storage.mjs"

const descriptor = {
  pluginId: "acme.tools",
  pluginVersion: "1.0.0",
  manifestHash: "sha256:manifest",
  catalogHash: "sha256:catalog",
}

test("hydrates host state and treats the proxy copy as a rebuildable cache", async () => {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === "cognia/state/keys") {
      return params.area === "global" ? ["theme"] : ["selection"]
    }
    if (method === "cognia/state/get") {
      return params.key === "theme" ? "dark" : { line: 7 }
    }
    if (method === "cognia/secrets/keys") return []
    return null
  }
  const storage = await createManagedStorageFacade({
    request,
    descriptor,
    hostId: "local",
    workspaceRoot: "/work/project",
    getWorkspaceTrusted: () => true,
  })

  assert.equal(storage.globalState.get("theme"), "dark")
  assert.deepEqual(storage.workspaceState.get("selection"), { line: 7 })
  assert.deepEqual(storage.globalState.keys(), ["theme"])
  assert.ok(
    calls.every(
      ([, params]) =>
        params.pluginId === "acme.tools" &&
        params.hostId === "local" &&
        params.workspaceRoot === "/work/project" &&
        params.workspaceTrusted === true
    )
  )
})

test("updates the cache only after the Cognia host commits the mutation", async () => {
  let fail = true
  const request = async (method) => {
    if (method === "cognia/state/keys") return []
    if (method === "cognia/state/set" && fail) throw new Error("host unavailable")
    return null
  }
  const storage = await createManagedStorageFacade({
    request,
    descriptor,
    hostId: "local",
    workspaceRoot: "/work/project",
    getWorkspaceTrusted: () => true,
  })

  await assert.rejects(storage.workspaceState.update("selection", { line: 9 }), /host unavailable/)
  assert.equal(storage.workspaceState.get("selection"), undefined)
  fail = false
  await storage.workspaceState.update("selection", { line: 9 })
  assert.deepEqual(storage.workspaceState.get("selection"), { line: 9 })
  await storage.workspaceState.update("selection", undefined)
  assert.equal(storage.workspaceState.get("selection"), undefined)
})

test("keeps secret values out of the proxy cache and reports local changes", async () => {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === "cognia/state/keys" || method === "cognia/secrets/keys") return []
    if (method === "cognia/secrets/get") return "host-token"
    return null
  }
  const storage = await createManagedStorageFacade({
    request,
    descriptor,
    hostId: "remote-a",
    workspaceRoot: "/srv/project",
    getWorkspaceTrusted: () => true,
  })
  const changes = []
  storage.secrets.onDidChange((event) => changes.push(event.key))

  assert.equal(await storage.secrets.get("token"), "host-token")
  await storage.secrets.store("token", "next-token")
  await storage.secrets.delete("token")
  assert.deepEqual(changes, ["token", "token"])
  assert.equal(calls.find(([method]) => method === "cognia/secrets/set")[1].value, "next-token")
  assert.throws(() => storage.globalState.setKeysForSync(), /IDE_EXTENSION_STATE_SYNC_UNSUPPORTED/)
})
