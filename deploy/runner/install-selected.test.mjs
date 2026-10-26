import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  installRunnerShims,
  resolveNpx,
  resolveNpxInvocation,
  resolveNativeNpx,
  validateBase,
} from "./install-selected.mjs"

const pins = {
  node: { version: "26.8.2", minGlibc: "2.28" },
  runtimes: [
    {
      id: "codex-acp",
      commands: [{ name: "codex-acp", package: "@agentclientprotocol/codex-acp" }],
    },
  ],
}
const packages = { dependencies: { "@agentclientprotocol/codex-acp": "1.13.1" } }

test("native npx binding resolves aliases and relative paths without accepting wrapper self-references", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-native-npx-"))
  try {
    const wrapper = join(root, "wrapper")
    const native = join(root, "native-npx")
    writeFileSync(wrapper, "wrapper", { mode: 0o755 })
    writeFileSync(native, "native")
    symlinkSync(wrapper, join(root, "wrapper-alias"))
    symlinkSync(native, join(root, "native-alias"))
    assert.throws(() => resolveNativeNpx(wrapper, wrapper), /Runner wrapper/)
    assert.throws(() => resolveNativeNpx(join(root, "wrapper-alias"), wrapper), /Runner wrapper/)
    assert.equal(
      resolveNativeNpx(join(root, "native-alias"), wrapper),
      resolve(root, "native-alias")
    )
    const relativeBinding = resolveNativeNpx(relative(process.cwd(), native), wrapper)
    assert.ok(isAbsolute(relativeBinding))
    assert.equal(realpathSync.native(relativeBinding), realpathSync.native(native))
    assert.equal(resolveNativeNpx("", wrapper), null)
    assert.equal(resolveNativeNpx(undefined, wrapper), null)
    assert.throws(() => resolveNativeNpx(join(root, "missing"), wrapper), /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("native npx binding preserves the invocation name of toolchain multiplexer aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-native-npx-alias-"))
  try {
    const wrapper = join(root, "runner/bin/npx")
    mkdirSync(dirname(wrapper), { recursive: true })
    writeFileSync(wrapper, "wrapper", { mode: 0o755 })
    writeFileSync(
      join(root, "toolchain-shim"),
      '#!/bin/sh\ncase "$0" in */npx) echo native-npx;; *) echo wrong-invocation-name >&2; exit 5;; esac\n',
      { mode: 0o755 }
    )
    const alias = join(root, "npx")
    symlinkSync(join(root, "toolchain-shim"), alias)
    installRunnerShims({
      pins,
      packageJson: packages,
      root,
      nodePath: process.execPath,
      nativeNpx: resolveNativeNpx(alias, wrapper),
    })
    const result = spawnSync(wrapper, ["project-tool"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "native-npx")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("native npx paths retain POSIX traversal through directory symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-native-npx-traversal-"))
  try {
    mkdirSync(join(root, "toolchain/current"), { recursive: true })
    mkdirSync(join(root, "toolchain/bin"), { recursive: true })
    symlinkSync(join(root, "toolchain/current"), join(root, "alias"))
    const wrapper = join(root, "wrapper")
    writeFileSync(wrapper, "wrapper")
    writeFileSync(join(root, "toolchain/bin/npx"), "#!/bin/sh\necho native-npx\n", { mode: 0o755 })
    const invocation = `${root}/alias/../bin/npx`
    const baseline = spawnSync(invocation, [], { encoding: "utf8" })
    assert.equal(baseline.status, 0, baseline.stderr)
    const result = spawnSync(resolveNativeNpx(invocation, wrapper), [], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "native-npx")
    const relativeInvocation = `${relative(process.cwd(), root)}/alias/../bin/npx`
    const relativeBinding = resolveNativeNpx(relativeInvocation, wrapper)
    assert.ok(isAbsolute(relativeBinding))
    assert.equal(spawnSync(relativeBinding, [], { encoding: "utf8" }).stdout.trim(), "native-npx")
    symlinkSync(wrapper, join(root, "toolchain/bin/loop"))
    assert.throws(() => resolveNativeNpx(`${root}/alias/../bin/loop`, wrapper), /Runner wrapper/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("selected npx uses the frozen package and preserves arguments", () => {
  assert.deepEqual(resolveNpx(["-y", "@agentclientprotocol/codex-acp", "--help"], pins, packages), {
    command: "codex-acp",
    args: ["--help"],
  })
  assert.deepEqual(resolveNpx(["--yes", "@zed-industries/codex-acp", "--help"], pins, packages), {
    command: "codex-acp",
    args: ["--help"],
  })
  assert.deepEqual(resolveNpx(["@agentclientprotocol/codex-acp@1.13.1"], pins, packages), {
    command: "codex-acp",
    args: [],
  })
})

test("selected npx refuses missing, mutable, or unselected packages without fallback", () => {
  for (const args of [
    [],
    ["-p", "evil"],
    ["evil"],
    ["@openai/codex"],
    ["@agentclientprotocol/codex-acp@"],
    ["@agentclientprotocol/codex-acp@latest"],
    ["@agentclientprotocol/codex-acp@1.0.0"],
  ]) {
    assert.throws(() => resolveNpx(args, pins, packages))
  }
})

test("custom runner bases require the pinned Node, glibc floor, and supported architecture", () => {
  assert.doesNotThrow(() => validateBase(pins, { node: "26.8.2", libc: "2.36", arch: "arm64" }))
  for (const base of [
    { node: "26.8.1", libc: "2.36", arch: "arm64" },
    { node: "26.8.2", libc: undefined, arch: "arm64" },
    { node: "26.8.2", libc: "2.27", arch: "arm64" },
    { node: "26.8.2", libc: "2.36", arch: "riscv64" },
  ])
    assert.throws(() => validateBase(pins, base))
})

test("installed npx dispatches locally with no npm executable and rejects unselected agents", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-runner-shim-"))
  try {
    mkdirSync(join(root, "glibc/bin"), { recursive: true })
    writeFileSync(join(root, "glibc/bin/codex-acp"), '#!/bin/sh\nprintf "frozen:%s\\n" "$1"\n', {
      mode: 0o755,
    })
    const native = join(root, "native-npx")
    writeFileSync(native, '#!/bin/sh\nprintf "project:%s\\n" "$*"\n', { mode: 0o755 })
    installRunnerShims({
      pins,
      packageJson: packages,
      root,
      nodePath: process.execPath,
      knownPackages: [...Object.keys(packages.dependencies), "@openai/codex"],
      nativeNpx: native,
    })
    const executable = join(root, "runner/bin/npx")
    const success = spawnSync(executable, ["-y", "@zed-industries/codex-acp", "--version"], {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(success.stdout, "frozen:--version\n")
    const missing = spawnSync(executable, ["-y", "@openai/codex"], {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /not installed/)
    const project = spawnSync(executable, ["tsc", "--noEmit"], {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    })
    assert.equal(project.status, 0, project.stderr)
    assert.equal(project.stdout, "project:--offline tsc --noEmit\n")
    assert.match(readFileSync(join(root, "runner/agent-selection.json"), "utf8"), /codex-acp/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("project npx preserves Full behavior while selected rejects unselected Agent package flags", () => {
  const options = {
    knownPackages: [...Object.keys(packages.dependencies), "@openai/codex"],
    nativeNpx: "/usr/local/bin/npx",
    commandsDir: "/cognia/glibc/bin",
  }
  assert.deepEqual(resolveNpxInvocation(["tsc", "--noEmit"], pins, packages, options), {
    path: "/usr/local/bin/npx",
    args: ["--offline", "tsc", "--noEmit"],
  })
  assert.deepEqual(
    resolveNpxInvocation(["cline", "--version"], pins, packages, { ...options, full: true }),
    { path: "/usr/local/bin/npx", args: ["cline", "--version"] }
  )
  for (const args of [
    ["@openai/codex"],
    ["-p", "@openai/codex", "codex"],
    ["--package=@openai/codex", "codex"],
    ["-p@openai/codex", "codex"],
  ]) {
    assert.throws(() => resolveNpxInvocation(args, pins, packages, options), /not installed/)
  }
  for (const flag of ["--offline=false", "--no-offline", "--offline=0"]) {
    assert.throws(
      () => resolveNpxInvocation([flag, "tsc"], pins, packages, options),
      /stay offline/
    )
  }
})

test("selected npx parses boolean flags before frozen Agent dispatch and blocks all offline negations", () => {
  const options = {
    knownPackages: [...Object.keys(packages.dependencies), "@openai/codex", "@google/gemini-cli"],
    knownCommands: ["codex-acp", "codex", "gemini"],
    nativeNpx: "/usr/local/bin/npx",
    commandsDir: "/cognia/glibc/bin",
  }
  for (const flag of ["--yes=true", "--yes=false"]) {
    assert.deepEqual(
      resolveNpxInvocation(
        [flag, "@agentclientprotocol/codex-acp", "--help"],
        pins,
        packages,
        options
      ),
      { path: "/cognia/glibc/bin/codex-acp", args: ["--help"] }
    )
    assert.throws(
      () => resolveNpxInvocation([flag, "@google/gemini-cli"], pins, packages, options),
      /not installed/
    )
    assert.throws(
      () => resolveNpxInvocation([flag, "@openai/codex@latest"], pins, packages, options),
      /not installed/
    )
  }
  for (const flag of [
    "--no-offline=true",
    "--no-offline=false",
    "--no-offline=0",
    "--offline=false",
    "--offline=0",
    "--offline=",
    "--offline=false",
  ]) {
    assert.throws(
      () => resolveNpxInvocation([flag, "missing"], pins, packages, options),
      /stay offline/
    )
  }
  for (const flag of [
    "--of=false",
    "--userconfig=evil",
    "--yes=invalid",
    "--call=codex",
    "-c",
    "--no",
    "--package-manager=npm",
    "-p=@openai/codex",
    "--package=tool@npm:@openai/codex",
  ]) {
    assert.throws(
      () => resolveNpxInvocation([flag, "tsc"], pins, packages, options),
      /unsupported|requires/
    )
  }
  assert.deepEqual(
    resolveNpxInvocation(["--yes=true", "codex-acp", "--help"], pins, packages, options),
    { path: "/cognia/glibc/bin/codex-acp", args: ["--help"] }
  )
  assert.deepEqual(
    resolveNpxInvocation(["codex-acp", "--offline=false"], pins, packages, options),
    { path: "/cognia/glibc/bin/codex-acp", args: ["--offline=false"] }
  )
  assert.throws(() => resolveNpxInvocation(["codex"], pins, packages, options), /not installed/)
  assert.throws(
    () => resolveNpxInvocation(["tool@npm:@openai/codex"], pins, packages, options),
    /unsupported/
  )
  assert.deepEqual(
    resolveNpxInvocation(
      ["--yes=true", "--package=typescript", "tsc", "--noEmit"],
      pins,
      packages,
      options
    ),
    {
      path: "/usr/local/bin/npx",
      args: ["--offline", "--yes=true", "--package=typescript", "tsc", "--noEmit"],
    }
  )
  assert.deepEqual(
    resolveNpxInvocation(["--userconfig=custom", "tsc"], pins, packages, {
      ...options,
      full: true,
    }),
    { path: "/usr/local/bin/npx", args: ["--userconfig=custom", "tsc"] }
  )
})

test("Full installer takes exact canonical versions and rejects mutable overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-runner-full-"))
  try {
    const npmLog = join(root, "npm.log")
    writeFileSync(join(root, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COGNIA_TEST_NPM_LOG"\n', {
      mode: 0o755,
    })
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.endsWith("_VERSION"))
    )
    const env = {
      ...inherited,
      PATH: `${root}:${process.env.PATH}`,
      COGNIA_TEST_NPM_LOG: npmLog,
      INSTALL_CURSOR_AGENT: "0",
      INSTALL_KIRO_CLI: "0",
      INSTALL_DROID_CLI: "0",
      COGNIA_AGENT_SHIM_SCRIPT: "/nonexistent",
    }
    const result = spawnSync("bash", ["deploy/runner/install-agents.sh"], { encoding: "utf8", env })
    assert.equal(result.status, 0, result.stderr)
    const log = readFileSync(npmLog, "utf8")
    assert.match(log, /@openai\/codex@0\.157\.1/)
    assert.match(log, /@agentclientprotocol\/codex-acp@1\.13\.1/)
    assert.match(log, /cline@3\.0\.73/)
    assert.doesNotMatch(log, /@latest/)
    assert.match(log, /install -g --ignore-scripts/)
    assert.match(
      log,
      /rebuild -g --foreground-scripts --allow-scripts=@anthropic-ai\/claude-code,opencode-ai @anthropic-ai\/claude-code opencode-ai/
    )
    const bad = spawnSync("bash", ["deploy/runner/install-agents.sh"], {
      encoding: "utf8",
      env: { ...env, CODEX_VERSION: "latest" },
    })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /exact version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("native npx offline-negation reproduction stays blocked by the installed selected wrapper", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-runner-native-npx-"))
  try {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true })
    writeFileSync(join(root, "package.json"), "{}")
    writeFileSync(
      join(root, "node_modules/.bin/cognia-offline-probe"),
      `#!${process.execPath}\nconsole.log(process.env.npm_config_offline ?? "unset")\n`,
      { mode: 0o755 }
    )
    const nativeNpx = join(dirname(process.execPath), "npx")
    const bypass = spawnSync(
      nativeNpx,
      ["--offline", "--no-offline=true", "cognia-offline-probe"],
      { cwd: root, encoding: "utf8" }
    )
    assert.equal(bypass.status, 0, bypass.stderr)
    assert.equal(bypass.stdout.trim(), "unset")
    installRunnerShims({ pins, packageJson: packages, root, nativeNpx, nodePath: process.execPath })
    const selectedNpx = join(root, "runner/bin/npx")
    const blocked = spawnSync(selectedNpx, ["--no-offline=true", "cognia-offline-probe"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /stay offline/)
    const local = spawnSync(selectedNpx, ["--yes=true", "cognia-offline-probe"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(local.status, 0, local.stderr)
    assert.equal(local.stdout.trim(), "true")
    writeFileSync(
      join(root, "node_modules/.bin/cognia-argument-probe"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ offline: process.env.npm_config_offline, args: process.argv.slice(2) }))\n`,
      { mode: 0o755 }
    )
    const forwarded = spawnSync(
      selectedNpx,
      ["cognia-argument-probe", "--offline=false", "--no-offline=true"],
      {
        cwd: root,
        encoding: "utf8",
      }
    )
    assert.equal(forwarded.status, 0, forwarded.stderr)
    assert.deepEqual(JSON.parse(forwarded.stdout), {
      offline: "true",
      args: ["--offline=false", "--no-offline=true"],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Full vendor downloads fail closed on a mismatched canonical SHA256", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-runner-vendor-"))
  try {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.endsWith("_VERSION"))
    )
    writeFileSync(join(root, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(root, "curl"), '#!/bin/sh\nprintf "tampered" > "$4"\n', { mode: 0o755 })
    const result = spawnSync("bash", ["deploy/runner/install-agents.sh"], {
      encoding: "utf8",
      env: {
        ...inherited,
        PATH: `${root}:${process.env.PATH}`,
        INSTALL_CURSOR_AGENT: "0",
        INSTALL_KIRO_CLI: "1",
        INSTALL_DROID_CLI: "0",
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /FAILED|did NOT match/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("empty npm tags cannot escape frozen or omitted Agent dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-runner-empty-tag-"))
  try {
    mkdirSync(join(root, "node_modules/@openai/codex"), { recursive: true })
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true })
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.0.0" } })
    )
    writeFileSync(
      join(root, "node_modules/@openai/codex/package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: "0.0.0",
        bin: { codex: "bin.js" },
      })
    )
    writeFileSync(
      join(root, "node_modules/.bin/codex"),
      '#!/bin/sh\nprintf "wrong-local-version\\n"\n',
      { mode: 0o755 }
    )
    const nativeNpx = join(dirname(process.execPath), "npx")
    const baseline = spawnSync(nativeNpx, ["--offline", "@openai/codex@"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(baseline.status, 0, baseline.stderr)
    assert.equal(baseline.stdout.trim(), "wrong-local-version")
    installRunnerShims({
      pins,
      packageJson: packages,
      root,
      nativeNpx,
      nodePath: process.execPath,
      knownPackages: [...Object.keys(packages.dependencies), "@openai/codex"],
    })
    const wrapper = join(root, "runner/bin/npx")
    for (const spec of [
      "@openai/codex@",
      "@agentclientprotocol/codex-acp@",
      "@zed-industries/codex-acp@",
    ]) {
      const result = spawnSync(wrapper, [spec], { cwd: root, encoding: "utf8" })
      assert.equal(result.status, 1, `${spec}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /not installed|frozen at/)
      assert.doesNotMatch(result.stdout, /wrong-local-version/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
