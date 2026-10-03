import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const { ConfigurationStore, createWorkspaceConfiguration, packageJsonDefaults } =
  await import("../dist/vscode-shim/configuration.js")

function store() {
  const configuration = new ConfigurationStore()
  configuration.set(
    {
      "ext.server.path": "/usr/bin/x",
      "ext.server.args": ["-v"],
      "ext.mode": "a",
      "other.flag": true,
    },
    { "ext.mode": "b", "ext.server.env": { HOME: "/h" } },
    []
  )
  return configuration
}

test("reads values over defaults, and assembles a prefix into an object", () => {
  const configuration = store()
  assert.equal(configuration.get("ext.mode"), "b")
  assert.deepEqual(configuration.get("ext.server"), {
    path: "/usr/bin/x",
    args: ["-v"],
    env: { HOME: "/h" },
  })
  assert.equal(configuration.get("ext.nope"), undefined)
  // A copy: changing it does not change the setting.
  configuration.get("ext.server.args").push("-x")
  assert.deepEqual(configuration.get("ext.server.args"), ["-v"])
  assert.deepEqual(configuration.inspect("ext.mode"), {
    key: "ext.mode",
    defaultValue: "a",
    globalValue: "b",
  })
})

test("getConfiguration exposes the section's settings and the methods", async () => {
  const configuration = store()
  const sent = []
  const connection = { sendRequest: async (method, params) => (sent.push([method, params]), null) }
  const section = createWorkspaceConfiguration({
    store: configuration,
    connection,
    extensionId: "ext.id",
    section: "ext.server",
  })
  assert.equal(section.path, "/usr/bin/x")
  assert.deepEqual(Object.keys(section).sort(), ["args", "env", "path"])
  assert.equal(section.get("path"), "/usr/bin/x")
  assert.equal(section.get("missing", 7), 7)
  assert.equal(section.has("env"), true)
  assert.equal(section.has("missing"), false)
  assert.ok(Object.isFrozen(section))

  await section.update("path", "/opt/x", false)
  await section.update("args", undefined)
  assert.deepEqual(sent, [
    [
      "workspace:configurationUpdate",
      { extensionId: "ext.id", key: "ext.server.path", value: "/opt/x", target: 2 },
    ],
    [
      "workspace:configurationUpdate",
      { extensionId: "ext.id", key: "ext.server.args", remove: true, target: 1 },
    ],
  ])
  await assert.rejects(section.update("path", "x", true, true), /Language-specific/)

  const whole = createWorkspaceConfiguration({ store: configuration, connection, extensionId: "e" })
  assert.equal(whole.get("other.flag"), true)
  assert.equal(whole.ext.mode, "b")
})

test("change events say which settings they affect", () => {
  const configuration = store()
  const events = []
  configuration.onDidChange.event((event) => events.push(event))
  configuration.set({}, {}, [])
  assert.equal(events.length, 0, "a report that changed nothing fires nothing")
  configuration.set({}, { "ext.server.path": "/x" }, ["ext.server.path"])
  const [event] = events
  assert.equal(event.affectsConfiguration("ext"), true)
  assert.equal(event.affectsConfiguration("ext.server"), true)
  assert.equal(event.affectsConfiguration("ext.server.path"), true)
  assert.equal(event.affectsConfiguration("ext.server.path.deeper"), true)
  assert.equal(event.affectsConfiguration("ext.mode"), false)
  assert.equal(event.affectsConfiguration("ex"), false)
})

test("the extension's own package.json supplies defaults the app does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"))
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      contributes: {
        configuration: [
          {
            properties: {
              "own.size": { type: "number", default: 3 },
              "own.mode": { default: "x" },
            },
          },
          { properties: { "own.size": { default: 99 }, "own.none": { type: "string" } } },
        ],
      },
    })
  )
  const configuration = new ConfigurationStore()
  configuration.loadOwnDefaults(dir)
  assert.equal(configuration.get("own.size"), 3)
  configuration.set({ "own.size": 4 }, {}, [])
  assert.equal(configuration.get("own.size"), 4, "the app's report wins")
  assert.deepEqual(
    packageJsonDefaults({ contributes: { configuration: { properties: { a: { default: 1 } } } } }),
    {
      a: 1,
    }
  )
  configuration.loadOwnDefaults(join(dir, "missing"))
  assert.equal(configuration.get("own.mode"), undefined)
})
