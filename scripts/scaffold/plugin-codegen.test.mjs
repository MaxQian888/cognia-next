import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import { runCodegen } from "./plugin-codegen.mjs"

function memFs(files) {
  const written = {}
  return {
    readFile: (path) => {
      const key = path.replaceAll("\\", "/")
      const match = Object.keys(files).find((f) => key.endsWith(f))
      if (match === undefined) throw new Error(`ENOENT ${path}`)
      return files[match]
    },
    writeFile: (path, content) => {
      written[path.replaceAll("\\", "/")] = content
    },
    written,
  }
}

test("runCodegen writes a TS artifact for a frontend plugin", () => {
  const fs = memFs({
    "plugin.json": JSON.stringify({
      type: "frontend",
      configSchema: { type: "object", properties: { x: { type: "string" } } },
    }),
  })
  const written = runCodegen({ pluginDir: "/plug", readFile: fs.readFile, writeFile: fs.writeFile })
  assert.equal(written.length, 1)
  const out = fs.written[join("/plug", "config.generated.ts").replaceAll("\\", "/")]
  assert.match(out, /export interface PluginConfig/)
  assert.match(out, /x\?: string/)
})

test("runCodegen writes a Python artifact for a python plugin", () => {
  const fs = memFs({
    "plugin.json": JSON.stringify({
      type: "python",
      configSchema: { type: "object", required: ["k"], properties: { k: { type: "number" } } },
    }),
  })
  runCodegen({ pluginDir: "/plug", readFile: fs.readFile, writeFile: fs.writeFile })
  const out = fs.written[join("/plug", "config_generated.py").replaceAll("\\", "/")]
  assert.match(out, /class PluginConfig\(TypedDict\):/)
  assert.match(out, /    k: float/)
})

test("runCodegen surfaces a clear error on an unreadable manifest", () => {
  const fs = memFs({})
  assert.throws(
    () => runCodegen({ pluginDir: "/missing", readFile: fs.readFile, writeFile: fs.writeFile }),
    /failed to read plugin manifest/
  )
})

test("runCodegen logs each written path", () => {
  const fs = memFs({
    "plugin.json": JSON.stringify({
      type: "frontend",
      configSchema: { type: "object", properties: {} },
    }),
  })
  const logged = []
  runCodegen({
    pluginDir: "/plug",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    log: (m) => logged.push(m),
  })
  assert.equal(logged.length, 1)
  assert.match(logged[0], /wrote .*config\.generated\.ts/)
})
