import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const json = (path) => JSON.parse(read(path))
const command = "environment_delivery_list"

test("delivery history is a paged host read on every companion transport", () => {
  const descriptor = json("protocol/companion-commands.json").commands.find(
    (entry) => entry.name === command
  )
  assert.equal(descriptor.resource, "environment.delivery")
  assert.equal(descriptor.operation, "read")
  assert.equal(descriptor.capability, "host.observe")
  assert.equal(descriptor.target, "execution")
  assert.equal(descriptor.pagination, "page-token")
  assert.deepEqual(descriptor.transports, ["http", "websocket", "webrtc"])
  const request = json("protocol/companion-request-schemas.json").commands[command]
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(Object.keys(request.properties).sort(), [
    "agentId",
    "pageSize",
    "pageToken",
    "taskId",
  ])
  assert.equal(request.properties.pageSize.maximum, 1000)
})

test("delivery reads stay reachable with the pool off and bypass the idempotency cache", () => {
  const source = read("crates/cognia-companion-rpc/src/rpc/environment.rs")
  const dispatch = source.slice(source.indexOf("async fn dispatch_arm("))
  assert.ok(
    dispatch.indexOf(`name == "${command}"`) < dispatch.indexOf("let services = services(name)?")
  )
  // Delivery history lives in the host's cognia data root: a `cognia/`
  // subdirectory on the desktop, the data dir itself on a headless host.
  assert.match(dispatch, /host\s*\.cognia_data_dir\(\)/)
  assert.match(
    read("src-tauri/src/companion_api/dispatch_host.rs"),
    /Self::Tauri\(_\) => Ok\(self\.data_dir\(\)\?\.join\("cognia"\)\)/
  )
  assert.match(
    read("crates/cognia-companion-rpc/src/rpc_host.rs"),
    /fn cognia_data_dir\(&self\) -> Result<PathBuf, String> \{\s*Ok\(self\.data_dir\.clone\(\)\)/
  )
  const rpc = read("crates/cognia-companion-rpc/src/rpc.rs")
  assert.equal(rpc.split(`"${command}"`).length - 1, 2)
  assert.ok(
    read("src-tauri/src/companion_api/output_registry.rs").includes(
      `("${command}", OutputShape::Derived`
    )
  )
  assert.ok(read("lib/tauri/local-environment-commands.ts").includes(`"${command}"`))
})

test("desktop reconciles remote delivery history before installing its spawn router", () => {
  const source = read("src-tauri/src/startup/services.rs")
  const startup = source.slice(source.indexOf("pub(crate) fn remote_sandboxes("))
  const recovery = startup.indexOf("block_on(pool.backend.reap_orphans())")
  assert.ok(recovery > 0)
  assert.ok(recovery < startup.indexOf("state.install_router(pool.backend)"))
})
