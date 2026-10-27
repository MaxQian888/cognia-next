/** @jest-environment node */
import {
  hermesOwnedEndpointBootstrap,
  validateHermesAcpBootstrap,
  replaceHermesRuntimeEntry,
  boundedHermesFrames,
} from "./hermes-acp-bridge"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = "/data/cognia/external-agents/configuration"
function payload() {
  return {
    configKey: "configuration",
    executable: "hermes",
    ownedStateRoot: root,
    expectedHome: `${root}/hermes`,
    expectedPid: 123,
    expectedStartupTime: Date.now(),
    profile: "default",
    instanceId: "b".repeat(32),
    authorityEpoch: 1,
    apiOrigin: "http://127.0.0.1:12345",
  }
}
describe("fixed Hermes ACP owned-endpoint bootstrap", () => {
  it("accepts only a fixed native launcher and a bound managed local authority", () => {
    const valid = payload()
    expect(validateHermesAcpBootstrap(JSON.stringify(valid), `${root}/hermes`)).toEqual(valid)
    for (const change of [
      { executable: "/usr/bin/python3" },
      { expectedHome: "/personal" },
      { ownedStateRoot: "/tmp/arbitrary" },
      { expectedPid: 0 },
      { instanceId: "" },
      { authorityEpoch: 0 },
      { apiOrigin: "http://example.com:1234" },
      { arbitraryCode: "print(1)" },
    ])
      expect(() =>
        validateHermesAcpBootstrap(JSON.stringify({ ...payload(), ...change }), `${root}/hermes`)
      ).toThrow()
  })
  it("replaces only the official final module entry, preserving native dependency bootstrap", () => {
    const prefix = "import sys,runpy; import hermes_bootstrap; "
    const command = [
      "/owned/python3",
      "-I",
      "-c",
      `${prefix}runpy.run_module(\"acp_adapter.entry\", run_name='__main__', alter_sys=True)`,
    ]
    const result = replaceHermesRuntimeEntry(command)
    expect(result.command).toBe("/owned/python3")
    expect(result.args[2]).toContain(prefix)
    expect(result.args[2]).toContain(JSON.stringify(hermesOwnedEndpointBootstrap))
    expect(result.args[2]).not.toContain('runpy.run_module("acp_adapter.entry"')
    for (const other of [
      ["/bin/sh", "-c", "anything"],
      ["/owned/python3", "-I", "-c", "print('not official')"],
      [...command, "extra"],
      ["python3", ...command.slice(1)],
    ])
      expect(() => replaceHermesRuntimeEntry(other)).toThrow("runtime command")
  })
  it("has no native ensure path and verifies authority before every initial/reconnect dial", () => {
    expect(hermesOwnedEndpointBootstrap).not.toContain("ensure_gateway_runtime")
    expect(hermesOwnedEndpointBootstrap).toContain(
      "gateway_server.connect_gateway = controlled_connect"
    )
    expect(hermesOwnedEndpointBootstrap).toContain("original_connect(endpoint=endpoint")
    for (const field of [
      "expectedPid",
      "expectedHome",
      "instanceId",
      "authorityEpoch",
      "apiOrigin",
      "start_time",
    ])
      expect(hermesOwnedEndpointBootstrap).toContain(field)
  })
  it("streams split UTF-8 byte-for-byte and rejects oversized newline-free protocol input", async () => {
    const stream = boundedHermesFrames(16),
      chunks: Buffer[] = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.write(Buffer.from([0xe4, 0xb8]))
    stream.end(Buffer.from([0xad, 10]))
    await once(stream, "end")
    expect(Buffer.concat(chunks)).toEqual(Buffer.from("中\n"))
    const malicious = boundedHermesFrames(16)
    const error = once(malicious, "error")
    malicious.write(Buffer.alloc(17, 65))
    expect((await error)[0]).toMatchObject({
      message: "Hermes ACP frame exceeds the supported size limit",
    })
  })

  const posixTest = process.platform === "win32" ? it.skip : it
  posixTest.each([false, true])(
    "runs the actual Python bootstrap and refuses replaced reconnect authority: %s",
    (replaced) => {
      const scratch = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bootstrap-test-"))
      )
      const managed = path.join(scratch, "cognia", "external-agents", "configuration")
      const home = path.join(managed, "hermes")
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      fs.chmodSync(managed, 0o700)
      const cfg = { ...payload(), ownedStateRoot: managed, expectedHome: home }
      fs.writeFileSync(
        path.join(home, "gateway_state.json"),
        JSON.stringify({
          pid: cfg.expectedPid,
          hermes_home: home,
          start_time: 777,
          updated_at: new Date().toISOString(),
        }),
        { mode: 0o600 }
      )
      const fixture = `
import types, sys, json, asyncio
from contextlib import asynccontextmanager
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
def module(name):
    value = types.ModuleType(name)
    value.__path__ = []
    sys.modules[name] = value
    if '.' in name:
        parent, leaf = name.rsplit('.', 1)
        setattr(sys.modules[parent], leaf, value)
    return value
for name in ['hermes_cli', 'hermes_cli.gateway_runtime', 'hermes_cli.gateway_runtime_discovery', 'hermes_cli.gateway_client', 'gateway', 'gateway.status', 'acp_adapter', 'acp_adapter.gateway_server', 'acp_adapter.entry']:
    module(name)
calls = 0
endpoint = types.SimpleNamespace(profile_id=cfg['expectedHome'], runtime_protocol=1, instance_id=cfg['instanceId'], authority_epoch=1, api_origin=cfg['apiOrigin'])
sys.modules['hermes_cli.gateway_runtime'].discover_gateway_endpoint = lambda home, timeout: types.SimpleNamespace(state='ready', endpoint=endpoint)
sys.modules['hermes_cli.gateway_runtime_discovery'].query_identify = lambda home, timeout: dict(pid=cfg['expectedPid'], hermes_home=cfg['expectedHome'], kind='hermes-gateway', start_time=777, instance_id=('f' * 32 if calls and ${replaced ? "True" : "False"} else cfg['instanceId']), authority_epoch=1)
sys.modules['gateway.status'].get_process_start_time = lambda pid: 777
@asynccontextmanager
async def original(endpoint=None, subject=None, max_size=None):
    global calls
    assert endpoint is not None, 'unsafe automatic gateway startup'
    calls += 1
    yield object()
sys.modules['hermes_cli.gateway_client'].connect_gateway = original
async def exercise():
    for _ in range(2):
        async with sys.modules['acp_adapter.gateway_server'].connect_gateway():
            pass
def main():
    asyncio.run(exercise())
    print('authenticated twice')
sys.modules['acp_adapter.entry'].main = main
`
      try {
        const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
          encoding: "utf8",
        }).trim()
        const run = () =>
          execFileSync(python, ["-I", "-c", `${fixture}\n${hermesOwnedEndpointBootstrap}`], {
            env: {
              ...process.env,
              HERMES_HOME: home,
              COGNIA_HERMES_ACP_BOOTSTRAP: JSON.stringify(cfg),
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 3000,
          })
        if (replaced) expect(run).toThrow()
        else expect(run()).toBe("authenticated twice\n")
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
      }
    }
  )
})
