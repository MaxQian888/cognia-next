/** @jest-environment node */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  NativeAgentBridgeRegistry,
  hermesProbeOwnedStateRoot,
  validateNativeBridgeSandbox,
  resolveNativeBridgeInterpreter,
  resolveNativeBridgeBundleRoot,
  NATIVE_BRIDGE_NODE_IDENTITY_SCRIPT,
  type NativeAgentBridgePins,
  type NativeBridgeInterpreterProbe,
} from "./native-bridges"

const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")
describe("verified native bridge registry", () => {
  let root: string
  let pins: NativeAgentBridgePins
  let registry: NativeAgentBridgeRegistry
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "native-bridge-host-test-"))
    pins = {
      schemaVersion: 1,
      bridges: {
        codebuff: {
          file: "codebuff.cjs",
          args: ["--cognia-codebuff-bridge"],
          sha256: sha("// codebuff"),
        },
        "crush-http": {
          file: "crush-http.cjs",
          args: ["--cognia-crush-bridge"],
          sha256: sha("// crush-http"),
        },
        "hermes-probe": {
          file: "hermes-probe.cjs",
          args: ["--hermes-gateway-probe"],
          sha256: sha("// hermes-probe"),
        },
        "hermes-acp": {
          file: "hermes-acp.cjs",
          args: ["--cognia-hermes-acp"],
          sha256: sha("// hermes-acp"),
        },
      },
      dependencyFiles: { "node_modules/sdk/asset.wasm": sha("asset") },
    }
    for (const [id, pin] of Object.entries(pins.bridges))
      fs.writeFileSync(path.join(root, pin.file), `// ${id}`)
    fs.mkdirSync(path.join(root, "node_modules/sdk"), { recursive: true })
    fs.writeFileSync(path.join(root, "node_modules/sdk/asset.wasm"), "asset")
    for (const file of ["integrity.json", "pins.json"])
      fs.writeFileSync(path.join(root, file), JSON.stringify(pins))
    registry = new NativeAgentBridgeRegistry(root, pins, process.execPath)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  it("registers only a fixed bridge invocation on the actual host executable", () => {
    const launch = registry.resolve("codebuff")
    expect(launch).toEqual({
      command: fs.realpathSync(process.execPath),
      args: [path.join(fs.realpathSync(root), "codebuff.cjs"), "--cognia-codebuff-bridge"],
      sha256: pins.bridges.codebuff.sha256,
    })
    expect(registry.permits(launch.command, launch.args)).toBe(true)
    expect(registry.permits("node", launch.args)).toBe(false)
    expect(registry.permits(launch.command, [...launch.args, "--eval", "evil"])).toBe(false)
    expect(registry.permits(launch.command, [launch.args[0]])).toBe(false)
    expect(registry.permits(launch.command, ["--eval", "evil"])).toBe(false)
    expect(() => registry.resolve("../unknown")).toThrow(/unsupported/)
  })
  it("does not admit an unregistered script even when the bundle is valid", () => {
    expect(
      registry.permits(process.execPath, [
        path.join(root, "codebuff.cjs"),
        "--cognia-codebuff-bridge",
      ])
    ).toBe(false)
  })
  it("revokes fixed bridge authority when its verified interpreter changes", () => {
    const executable = root + "-fixture-node"
    fs.writeFileSync(executable, "verified node fixture")
    try {
      const fixed = new NativeAgentBridgeRegistry(root, pins, executable),
        launch = fixed.resolve("hermes-probe")
      fs.appendFileSync(executable, "changed")
      expect(() => fixed.permits(launch.command, launch.args)).toThrow(/interpreter changed/)
      expect(fixed.permits(launch.command, launch.args)).toBe(false)
    } finally {
      fs.unlinkSync(executable)
    }
  })
  it.each(["codebuff.cjs", "node_modules/sdk/asset.wasm"])(
    "rechecks %s at spawn and revokes authority after tampering",
    (file) => {
      const launch = registry.resolve("codebuff")
      fs.writeFileSync(path.join(root, file), "changed")
      expect(() => registry.permits(launch.command, launch.args)).toThrow(/integrity mismatch/)
      expect(registry.permits(launch.command, launch.args)).toBe(false)
      expect(() => registry.resolve("codebuff")).toThrow(/rebuild\/reinstall/)
    }
  )
  it("refuses repinning adjacent metadata, extra files, and missing files", () => {
    const changed = structuredClone(pins)
    changed.bridges.codebuff.sha256 = sha("changed")
    fs.writeFileSync(path.join(root, "codebuff.cjs"), "changed")
    fs.writeFileSync(path.join(root, "integrity.json"), JSON.stringify(changed))
    expect(() => registry.resolve("codebuff")).toThrow(/embedded pins/)
    fs.writeFileSync(path.join(root, "shadow.cjs"), "shadow")
    expect(() => registry.resolve("codebuff")).toThrow(/inventory/)
    fs.unlinkSync(path.join(root, "shadow.cjs"))
    fs.unlinkSync(path.join(root, "crush-http.cjs"))
    expect(() => registry.resolve("codebuff")).toThrow(/inventory/)
  })
  it("refuses symlinked files, nested directories, and the bundle directory", () => {
    fs.unlinkSync(path.join(root, "codebuff.cjs"))
    fs.symlinkSync(path.join(root, "crush-http.cjs"), path.join(root, "codebuff.cjs"))
    expect(() => registry.resolve("codebuff")).toThrow(/symlink/)
    fs.unlinkSync(path.join(root, "codebuff.cjs"))
    fs.writeFileSync(path.join(root, "codebuff.cjs"), "// codebuff")
    fs.renameSync(path.join(root, "node_modules/sdk"), path.join(root, "node_modules/original"))
    fs.symlinkSync(
      path.join(root, "node_modules/original"),
      path.join(root, "node_modules/sdk"),
      "dir"
    )
    expect(() => registry.resolve("codebuff")).toThrow(/symlink/)
    const link = root + "-link"
    fs.symlinkSync(root, link, "dir")
    try {
      expect(() =>
        new NativeAgentBridgeRegistry(link, pins, process.execPath).resolve("codebuff")
      ).toThrow(/redirected/)
    } finally {
      fs.unlinkSync(link)
    }
  })
  it("rejects changed fixed arguments or escaping embedded paths", () => {
    pins.bridges.codebuff.args.push("--eval")
    expect(() => registry.resolve("codebuff")).toThrow(/fixed invocation/)
    pins.bridges.codebuff.args.pop()
    pins.dependencyFiles["../escape.cjs"] = sha("evil")
    expect(() => registry.resolve("codebuff")).toThrow(/pin path/)
  })
  it("requires Codebuff network-off isolation on supported hosts", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(() => validateNativeBridgeSandbox("codebuff", "off", platform)).not.toThrow()
      for (const network of [undefined, "full", "allowlist"])
        expect(() => validateNativeBridgeSandbox("codebuff", network, platform)).toThrow(
          /network:'off'/
        )
    }
    expect(() => validateNativeBridgeSandbox("codebuff", "off", "win32")).toThrow(/mandatory/)
    expect(() => validateNativeBridgeSandbox("hermes-probe", "full", "linux")).not.toThrow()
  })
  it("derives the exact Hermes root from a state key and refuses path/symlink substitution", () => {
    const key = "saved-hermes-config"
    const owned = path.join(root, "cognia/external-agents", key)
    fs.mkdirSync(path.join(owned, "hermes"), { recursive: true })
    expect(hermesProbeOwnedStateRoot(key, root)).toBe(fs.realpathSync(owned))
    for (const bad of [undefined, "../escape", "config/child", " ", "a".repeat(129)])
      expect(() => hermesProbeOwnedStateRoot(bad, root)).toThrow(/owned Hermes/)
    expect(() => hermesProbeOwnedStateRoot(key, undefined)).toThrow(/host data/)
    fs.rmdirSync(path.join(owned, "hermes"))
    fs.symlinkSync(root, path.join(owned, "hermes"), "dir")
    expect(() => hermesProbeOwnedStateRoot(key, root)).toThrow(/redirected/)
  })
})

describe("plain Node interpreter for released hosts", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-node-test-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  function candidate(name: string) {
    const file = path.join(root, name)
    fs.writeFileSync(file, "fixture", { mode: 0o755 })
    return fs.realpathSync(file)
  }
  function reply(file: string, patch: Record<string, unknown> = {}) {
    return {
      status: 0,
      stdout: JSON.stringify({
        marker: "cognia-node-identity-v1",
        version: "26.1.0",
        release: "node",
        execPath: fs.realpathSync(file),
        bun: false,
        packaged: false,
        ...patch,
      }),
      stderr: "",
    }
  }
  it("uses genuine Node execPath without depending on PATH, with sanitized fixed identity flags", () => {
    const node = candidate("real-node"),
      probe = jest.fn<
        ReturnType<NativeBridgeInterpreterProbe>,
        Parameters<NativeBridgeInterpreterProbe>
      >(() => reply(node))
    expect(
      resolveNativeBridgeInterpreter({
        execPath: node,
        versions: { node: "26.1.0" },
        packaged: false,
        runtime: {
          platform: "linux",
          home: undefined,
          env: {
            PATH: "",
            NODE_OPTIONS: "--require untrusted.js",
            NODE_PATH: "/unsafe",
            COGNIA_ROLE: "sidecar",
          },
        },
        probe,
      })
    ).toBe(node)
    expect(probe).toHaveBeenCalledWith(
      node,
      ["--input-type=commonjs", "--eval", NATIVE_BRIDGE_NODE_IDENTITY_SCRIPT],
      expect.objectContaining({ timeout: 1500, maxBuffer: 4096, encoding: "utf8" })
    )
    const env = probe.mock.calls[0][2].env
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.COGNIA_ROLE).toBeUndefined()
  })
  it.each(["pkg", "bun"])(
    "resolves external plain Node for %s and never self-execs Cognia as an interpreter",
    (host) => {
      const self = candidate("cognia-agent"),
        node = candidate("node"),
        probe = jest.fn((file: string) => reply(file))
      expect(
        resolveNativeBridgeInterpreter({
          execPath: self,
          versions: { node: "26.1.0", ...(host === "bun" ? { bun: "1.4.0" } : {}) },
          packaged: host === "pkg",
          runtime: { platform: "linux", home: undefined, env: { PATH: root } },
          probe,
        })
      ).toBe(node)
      expect(probe.mock.calls.some(([file]) => file === self)).toBe(false)
    }
  )
  it.each([
    { bun: true },
    { packaged: true },
    { version: "24.9.0" },
    { release: "cognia-agent" },
    { execPath: "/missing/spoofed-node" },
  ])("refuses a masquerading or old runtime %j", (patch) => {
    const self = candidate("cognia-agent"),
      node = candidate("node"),
      probe = jest.fn(() => reply(node, patch))
    expect(() =>
      resolveNativeBridgeInterpreter({
        execPath: self,
        versions: { node: "26.0.0", bun: "1.4.0" },
        packaged: false,
        runtime: { platform: "linux", home: undefined, env: { PATH: root } },
        probe,
      })
    ).toThrow(/Install.*Node.js 26/)
  })
  it("locates Bun assets beside the released executable instead of its virtual module URL", () => {
    const executable = path.join(root, "cognia-agent")
    fs.mkdirSync(path.join(root, "sidecar/native-agents"), { recursive: true })
    expect(
      resolveNativeBridgeBundleRoot({
        execPath: executable,
        moduleUrl: "file:///$bunfs/root/cli/native-bridges.ts",
        packaged: false,
        bun: true,
      })
    ).toBe(path.join(root, "sidecar/native-agents"))
  })
})
