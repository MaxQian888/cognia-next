import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  DSH_VERSION,
  resolveMcpConfigs,
  resolveCogniaServices,
  managedProfileManifest,
  prepareLaunch,
  resolveProductLauncher,
} from "./launcher.mjs"

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cognia-dsh-launch-test-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, "dsh-home")
  const composition = join(root, "host.sdk-readonly.yml")
  writeFileSync(composition, "[]\n")
  return {
    root,
    home,
    composition,
    argv: ["node", "launcher.mjs", composition],
    env: { COGNIA_DSH_RUNTIME_HOME: root, DSH_HOME: home, COGNIA_DSH_WORKSPACE: root },
  }
}

test("prepares a deterministic startup-only managed profile, idempotently", (t) => {
  const f = fixture(t)
  const result = prepareLaunch(f.argv, f.env)
  assert.equal(result.profile, "cognia-sdk-readonly")
  assert.equal(result.sessionRoot, join(f.root, "sessions"))
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.home, "profiles", result.profile, "package.json"))),
    managedProfileManifest(result.profile)
  )
  assert.deepEqual(prepareLaunch(f.argv, f.env), result)
})

test("rejects missing ownership, relative/extra arguments and unowned compositions", (t) => {
  const f = fixture(t)
  assert.throws(() => prepareLaunch(f.argv, {}), /must be set/)
  assert.throws(() => prepareLaunch(["node", "launcher", "relative.yml"], f.env), /Usage/)
  assert.throws(() => prepareLaunch([...f.argv, "--patch"], f.env), /Usage/)
  const rogue = join(f.root, "rogue.yml")
  writeFileSync(rogue, "[]")
  assert.throws(() => prepareLaunch(["node", "launcher", rogue], f.env), /managed host/)
})

test("rejects sibling and nonexistent paths behind symlink escapes", (t) => {
  const f = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), "cognia-dsh-outside-"))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(f.root, "link"))
  assert.throws(
    () => prepareLaunch(f.argv, { ...f.env, DSH_HOME: join(f.root, "link", "new-home") }),
    /inside/
  )
  assert.throws(() => prepareLaunch(f.argv, { ...f.env, DSH_HOME: f.root }), /isolated/)
  assert.throws(
    () => prepareLaunch(f.argv, { ...f.env, COGNIA_DSH_SESSION_ROOT: outside }),
    /persistence/
  )
})

test("refuses hidden patch layers and environment files before launch", (t) => {
  for (const name of [
    "cordis.patch.yml",
    ".env",
    "profiles/cognia-sdk-readonly/cordis.patch.yml",
  ]) {
    const f = fixture(t)
    prepareLaunch(f.argv, f.env)
    writeFileSync(join(f.home, name), "")
    assert.throws(() => prepareLaunch(f.argv, f.env), /Unmanaged DSH/)
  }
})

test("refuses profile dependency injection and symlinked profile directories", (t) => {
  const f = fixture(t)
  prepareLaunch(f.argv, f.env)
  const path = join(f.home, "profiles", "cognia-sdk-readonly", "package.json")
  writeFileSync(
    path,
    JSON.stringify({
      ...managedProfileManifest("cognia-sdk-readonly"),
      dependencies: { evil: "*" },
    })
  )
  assert.throws(() => prepareLaunch(f.argv, f.env), /manifest differs/)
  const second = fixture(t)
  mkdirSync(join(second.home, "profiles"), { recursive: true })
  symlinkSync(f.root, join(second.home, "profiles", "cognia-sdk-readonly"))
  assert.throws(() => prepareLaunch(second.argv, second.env), /escapes/)
})

test("rejects stale installed runtime packages before evaluating upstream code", (t) => {
  const f = fixture(t)
  const pkg = join(f.root, "package.json")
  writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }))
  assert.throws(() => resolveProductLauncher({ resolve: () => pkg }), /Unsupported/)
  writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: DSH_VERSION }))
  assert.equal(resolveProductLauncher({ resolve: () => pkg }), join(f.root, "lib", "bin.js"))
})

test("concurrent agents publish the same complete profile manifest", async (t) => {
  const f = fixture(t)
  const code = `import { prepareLaunch } from ${JSON.stringify(new URL("./launcher.mjs", import.meta.url).href)}; prepareLaunch(${JSON.stringify(f.argv)}, ${JSON.stringify(f.env)})`
  await Promise.all(
    Array.from({ length: 8 }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])
    )
  )
  assert.deepEqual(readdirSync(join(f.home, "profiles", "cognia-sdk-readonly")), ["package.json"])
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.home, "profiles", "cognia-sdk-readonly", "package.json"))),
    managedProfileManifest("cognia-sdk-readonly")
  )
})

test("normalizes SDK MCP stdio and HTTP descriptors with strict startup readiness", () => {
  const configs = resolveMcpConfigs(
    JSON.stringify([
      {
        name: "cognia-tools",
        command: process.execPath,
        args: ["bridge.mjs"],
        env: [{ name: "COGNIA_TOOLHOST_TOKEN", value: "fixture" }],
      },
      {
        name: "Remote tools",
        type: "http",
        url: "http://localhost/mcp",
        headers: [{ name: "Authorization", value: "Bearer fixture" }],
      },
    ]),
    "/workspace"
  )
  assert.equal(configs[0].serverName, "cognia-tools")
  assert.equal(configs[0].cwd, "/workspace")
  assert.equal(configs[0].env.COGNIA_TOOLHOST_TOKEN, "fixture")
  assert.equal(configs[0].failOnStartupError, true)
  assert.match(configs[1].serverName, /^Remote_tools_[a-f0-9]{8}$/)
  assert.equal(configs[1].transport, "streamable-http")
  assert.throws(() => resolveMcpConfigs("{}", "/workspace"), /array/)
  assert.throws(
    () =>
      resolveMcpConfigs(JSON.stringify([{ name: "x", command: "node", args: [] }]), "/workspace"),
    /absolute/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([{ name: "x", type: "sse", url: "https://example.test" }]),
        "/workspace"
      ),
    /transport/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([{ name: "x", type: "http", url: "file:///tmp/a" }]),
        "/workspace"
      ),
    /HTTP/
  )
  assert.throws(
    () =>
      resolveMcpConfigs(
        JSON.stringify([
          {
            name: "x",
            type: "http",
            url: "http://localhost",
            headers: [
              { name: "A", value: "a" },
              { name: "a", value: "b" },
            ],
          },
        ]),
        "/workspace"
      ),
    /Duplicate/
  )
})

test("Cognia service config enforces scoped MCP and explicit gateway lease", () => {
  const gateway = {
    providers: {
      cognia: {
        api: "openai-completions",
        baseURL: "http://127.0.0.1:1234/v1",
        apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
        models: [{ id: "proxy" }],
      },
    },
  }
  const env = {
    COGNIA_DSH_PROVIDER: "cognia",
    COGNIA_DSH_MODEL: "proxy",
    COGNIA_DSH_GATEWAY_TOKEN: "fixture",
    COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify(gateway),
  }
  assert.deepEqual(resolveCogniaServices(env, "/workspace", "cognia-sdk-readonly").gateway, gateway)
  assert.throws(
    () =>
      resolveCogniaServices(
        { ...env, COGNIA_DSH_GATEWAY_TOKEN: "" },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /lease/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        { ...env, COGNIA_DSH_MODEL: "other" },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /selected model/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        {
          COGNIA_DSH_MCP_SERVERS: JSON.stringify([
            { name: "x", command: process.execPath, args: [] },
          ]),
        },
        "/workspace",
        "cognia-acp"
      ),
    /session\/new/
  )
  assert.throws(
    () =>
      resolveCogniaServices(
        { COGNIA_DSH_ADDITIONAL_DIRECTORIES: '["relative"]' },
        "/workspace",
        "cognia-sdk-readonly"
      ),
    /absolute/
  )
  assert.deepEqual(
    resolveCogniaServices(
      {
        COGNIA_DSH_ALLOWED_TOOLS: '["read"]',
        COGNIA_DSH_ADDITIONAL_DIRECTORIES: '["/additional"]',
      },
      "/workspace",
      "cognia-sdk-readonly"
    ),
    { mcp: [], gateway: undefined }
  )
})
