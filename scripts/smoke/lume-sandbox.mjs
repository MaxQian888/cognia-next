/** Read-only native IPC smoke. Optional capture requires an already qualified guest. */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { connectTauriPage } from "../tauri/agent-debug-client.mjs"

export function validateDiagnostics(value) {
  assert.equal(value.contractVersion, 1, "incompatible Lume Host contract")
  assert.equal(value.lumeVersion, "0.6.1", "unexpected Lume version lock")
  assert.equal(typeof value.enabled, "boolean")
  assert.ok(Array.isArray(value.resources))
  for (const resource of value.resources) {
    assert.ok(resource.resourceId && resource.bootEpoch && resource.connectionId)
    assert.ok(Number.isSafeInteger(resource.generation) && resource.generation > 0)
    for (const stage of ["vm", "ssh", "helper", "gui"])
      assert.equal(typeof resource.readiness[stage], "boolean")
  }
}

export async function runSmoke({
  resourceId,
  output = ".cache/lume-sandbox/native-smoke.json",
} = {}) {
  const page = connectTauriPage()
  const capabilities = await page.capabilities()
  assert.equal(capabilities.apiVersion, 3, "start the authenticated agent-debug shell first")
  const diagnostics = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("lume_sandbox_local_call", { request: { kind: "diagnose" } })
  )
  validateDiagnostics(diagnostics)
  const refusesUnknownOperation = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("lume_sandbox_local_call", {
        request: { kind: "runHostShell", command: "false" },
      })
      return false
    } catch {
      return true
    }
  })
  assert.ok(refusesUnknownOperation, "native ingress accepted an unknown operation")
  const report = {
    date: new Date().toISOString(),
    scope: "real Tauri IPC; no VM provisioning, startup, input or deletion",
    contractVersion: diagnostics.contractVersion,
    lumeVersion: diagnostics.lumeVersion,
    platformSupported: diagnostics.platformSupported,
    featureEnabled: diagnostics.enabled,
    resourceCount: diagnostics.resources.length,
    refusesUnknownOperation,
    capture: null,
    realVmAcceptance: "pending",
  }
  if (resourceId) {
    const resource = diagnostics.resources.find((candidate) => candidate.resourceId === resourceId)
    assert.ok(resource, "resource is not owned by this unlocked account")
    assert.ok(
      diagnostics.enabled && resource.readiness.gui && !resource.quarantine,
      "guest GUI is unqualified"
    )
    const frame = await page.evaluate(
      (connectionId) =>
        window.__TAURI_INTERNALS__.invoke("cua_sandbox_desktop_capture", { connectionId }),
      resource.connectionId
    )
    assert.ok(frame.frameId && frame.screenshot.width > 0 && frame.screenshot.height > 0)
    const image = Buffer.from(frame.screenshot.bytes, "base64")
    assert.ok(image.length > 0 && image.length <= 12 * 1024 * 1024)
    report.capture = {
      width: frame.screenshot.width,
      height: frame.screenshot.height,
      sha256: createHash("sha256").update(image).digest("hex"),
    }
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--resource-id": "resourceId", "--output": "output" }[args[index]]
    if (!key || !args[index + 1] || Object.hasOwn(options, key))
      throw new Error("usage: lume-sandbox.mjs [--resource-id ID] [--output PATH]")
    options[key] = args[index + 1]
  }
  console.log(JSON.stringify(await runSmoke(options), null, 2))
}
