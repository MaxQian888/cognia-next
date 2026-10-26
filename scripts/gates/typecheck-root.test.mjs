import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { resolveRootCompiler } from "./typecheck-root.mjs"

const version = "7.1.0-dev.20261019.1"
const stable = "7.0.2"
const platforms = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "arm64"],
  ["win32", "x64"],
]
const runner = fileURLToPath(new URL("./typecheck-root.mjs", import.meta.url))

test("repository wiring opts only the heavy root noEmit check into the seven exact pins", () => {
  const root = join(dirname(runner), "../..")
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const pins = Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith("@typescript/typescript-")
  )
  assert.deepEqual(
    pins.map(([name]) => name).sort(),
    platforms.map(([platform, arch]) => `@typescript/typescript-${platform}-${arch}`).sort()
  )
  for (const [, pin] of pins) assert.equal(pin, version)
  assert.equal(manifest.devDependencies["@typescript/native"], `npm:typescript@${stable}`)
  assert.equal(manifest.devDependencies.typescript, "npm:@typescript/typescript6@6.0.2")
  assert.equal(
    manifest.scripts.typecheck,
    "pnpm run sidecar:webclone:build && cross-env GOMEMLIMIT=10GiB GOMAXPROCS=2 node scripts/gates/typecheck-root.mjs --noEmit --checkers 1 --tsBuildInfoFile .cache/typecheck/root.tsbuildinfo && pnpm run sidecar:typecheck"
  )
  assert.deepEqual(
    Object.entries(manifest.scripts)
      .filter(([, value]) => value.includes("typecheck-root.mjs"))
      .map(([key]) => key),
    ["typecheck"]
  )
  assert.doesNotMatch(manifest.scripts["sidecar:typecheck"], /typecheck-root/)
  assert.match(manifest.scripts["sidecar:typecheck"], /tsc --checkers 1 -p sidecar\/tsconfig\.json/)
  assert.match(
    manifest.scripts["sidecar:typecheck"],
    /tsc --checkers 1 -p sidecar\/tsconfig\.pi-extension\.json/
  )
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cognia-root-compiler-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, "scripts/gates"), { recursive: true })
  copyFileSync(runner, join(root, "scripts/gates/typecheck-root.mjs"))
  const manifest = {
    devDependencies: { "@typescript/native": `npm:typescript@${stable}` },
    optionalDependencies: Object.fromEntries(
      platforms.map(([platform, arch]) => [`@typescript/typescript-${platform}-${arch}`, version])
    ),
  }
  const save = () => writeFileSync(join(root, "package.json"), JSON.stringify(manifest))
  save()
  function install(name, installedVersion = version, source = "", platform = process.platform) {
    const directory = join(root, "node_modules", name)
    const bin =
      name === "@typescript/native" ? "bin/tsc" : `lib/tsc${platform === "win32" ? ".exe" : ""}`
    mkdirSync(dirname(join(directory, bin)), { recursive: true })
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version: installedVersion })
    )
    writeFileSync(join(directory, bin), source, { mode: 0o755 })
    return join(directory, bin)
  }
  return { root, manifest, save, install }
}

test("selects every published preview platform without a shadowing tsc shim", (t) => {
  const f = fixture(t)
  for (const [platform, arch] of platforms) {
    const name = `@typescript/typescript-${platform}-${arch}`
    const binary = f.install(name, version, "", platform)
    assert.deepEqual(resolveRootCompiler(f.root, platform, arch), {
      executable: binary,
      prefix: [],
    })
  }
})

test("long Windows compiler paths retain the official extended-path handling", (t) => {
  const f = fixture(t)
  const root = join(f.root, ...Array.from({ length: 15 }, () => "long-workspace-path"))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify(f.manifest))
  const directory = join(root, "node_modules/@typescript/typescript-win32-x64")
  mkdirSync(join(directory, "lib"), { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }))
  const binary = join(directory, "lib/tsc.exe")
  writeFileSync(binary, "")
  assert.ok(binary.length >= 248)
  assert.deepEqual(resolveRootCompiler(root, "win32", "x64"), {
    executable: `\\\\?\\${binary}`,
    prefix: [],
  })
})

test("other stable-supported platforms retain the official stable launcher", (t) => {
  const f = fixture(t)
  const binary = f.install("@typescript/native", stable)
  for (const [platform, arch] of [
    ["linux", "riscv64"],
    ["linux", "ppc64"],
    ["linux", "s390x"],
    ["linux", "loong64"],
    ["linux", "mips64el"],
    ["freebsd", "x64"],
    ["freebsd", "arm64"],
    ["netbsd", "x64"],
    ["netbsd", "arm64"],
    ["openbsd", "x64"],
    ["openbsd", "arm64"],
    ["aix", "ppc64"],
    ["sunos", "x64"],
  ]) {
    assert.deepEqual(resolveRootCompiler(f.root, platform, arch), {
      executable: process.execPath,
      prefix: [binary],
    })
  }
})

test("supported missing, wrong-version or missing-binary installs fail despite available stable", (t) => {
  const f = fixture(t)
  f.install("@typescript/native", stable)
  const name = "@typescript/typescript-darwin-arm64"
  assert.throws(() => resolveRootCompiler(f.root, "darwin", "arm64"), /install root dependencies/)
  const binary = f.install(name, "7.0.2")
  assert.throws(() => resolveRootCompiler(f.root, "darwin", "arm64"), /found 7\.0\.2/)
  f.install(name)
  rmSync(binary)
  assert.throws(() => resolveRootCompiler(f.root, "darwin", "arm64"), /compiler is missing/)
})

test("rejects floating preview pins and mismatched stable fallback", (t) => {
  const f = fixture(t)
  const name = "@typescript/typescript-darwin-arm64"
  for (const bad of ["next", "^7.1.0-dev.20261019.1", "7", "", null]) {
    f.manifest.optionalDependencies[name] = bad
    f.save()
    assert.throws(() => resolveRootCompiler(f.root, "darwin", "arm64"), /exact TypeScript 7/)
  }
  f.install("@typescript/native", "7.0.1")
  assert.throws(() => resolveRootCompiler(f.root, "linux", "riscv64"), /found 7\.0\.1/)
})

function prepareExecution(t, fallback = false) {
  const f = fixture(t)
  const name = `@typescript/typescript-${process.platform}-${process.arch}`
  if (!Object.hasOwn(f.manifest.optionalDependencies, name)) return undefined
  const executable =
    `#!${process.execPath}\n` +
    [
      "if (process.env.COMPILER_WAIT) {",
      '  process.stdout.write("READY\\n")',
      "  setInterval(() => {}, 1000)",
      "} else {",
      "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), value: process.env.COMPILER_VALUE }))",
      "  process.exit(Number(process.env.COMPILER_EXIT || 0))",
      "}",
    ].join("\n")
  f.install(name, version, executable)
  let entry = join(f.root, "scripts/gates/typecheck-root.mjs")
  if (fallback) {
    entry = join(f.root, "spawn-fallback.mjs")
    writeFileSync(
      entry,
      'import { runRootTypecheck } from "./scripts/gates/typecheck-root.mjs"\nprocess.execve = undefined\nrunRootTypecheck(new URL(".", import.meta.url).pathname)\n'
    )
  }
  const cwd = join(f.root, "caller-directory")
  mkdirSync(cwd)
  return { ...f, entry, cwd }
}

test("an undeclared platform executes the stable official launcher with the original args", (t) => {
  const f = fixture(t)
  delete f.manifest.optionalDependencies[
    `@typescript/typescript-${process.platform}-${process.arch}`
  ]
  f.save()
  f.install(
    "@typescript/native",
    stable,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))\nprocess.exit(7)\n"
  )
  const result = spawnSync(
    process.execPath,
    [join(f.root, "scripts/gates/typecheck-root.mjs"), "--noEmit", "argument with spaces"],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 7, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ["--noEmit", "argument with spaces"])
})

for (const fallback of [false, true]) {
  const mode = fallback ? "spawn fallback" : "official execve path"
  test(
    `${mode} preserves literal args, cwd, env and compiler diagnostic exit`,
    { skip: process.platform === "win32" },
    (t) => {
      const f = prepareExecution(t, fallback)
      if (!f) return t.skip("host platform has no preview package")
      const args = ["--noEmit", "--checkers", "1", "argument with spaces", 'a"b', "中文"]
      const result = spawnSync(process.execPath, [f.entry, ...args], {
        cwd: f.cwd,
        env: { ...process.env, COMPILER_VALUE: "preserved", COMPILER_EXIT: "2" },
        encoding: "utf8",
      })
      assert.equal(result.status, 2, result.stderr)
      assert.equal(result.signal, null)
      assert.deepEqual(JSON.parse(result.stdout), { argv: args, cwd: f.cwd, value: "preserved" })
    }
  )

  test(
    `${mode} forwards direct SIGTERM and preserves signal termination`,
    { skip: process.platform === "win32", timeout: 5000 },
    async (t) => {
      const f = prepareExecution(t, fallback)
      if (!f) return t.skip("host platform has no preview package")
      const child = spawn(process.execPath, [f.entry, "--noEmit"], {
        cwd: f.cwd,
        env: { ...process.env, COMPILER_WAIT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      })
      const exited = once(child, "exit")
      const [ready] = await once(child.stdout, "data")
      assert.match(ready.toString(), /READY/)
      child.kill("SIGTERM")
      assert.deepEqual(await exited, [null, "SIGTERM"])
    }
  )
}
