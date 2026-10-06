import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  BUNDLE_DOCS,
  checkVendor,
  computeBundleInclude,
  gitBlobSha1,
  isVendorPath,
  listVendorFiles,
  LOCK_FILE,
  renderVendorDoc,
  replaceBundleInclude,
  selectVendorPaths,
  syncVendor,
  UPSTREAM_URL,
  VENDOR_EXACT_PATHS,
} from "./sync-vendor.mjs"

const pluginRoot = resolve(__dirname, "..")

/** Files of a synthetic upstream commit: every rule hit, plus every exclusion. */
const UPSTREAM_FILES: Record<string, string> = {
  ...Object.fromEntries(VENDOR_EXACT_PATHS.map((path) => [path, `exact ${path}\n`])),
  "packages/contracts/schemas/other.schema.json": "{}\n",
  "packages/contracts/examples/tool-calls.json": "[]\n",
  "packages/cli/package.json": '{"name":"@latexwb/cli"}\n',
  "packages/cli/tsconfig.json": "{}\n",
  "packages/cli/src/bin.ts": "#!/usr/bin/env node\nconsole.log(1)\n",
  "packages/cli/test/args.test.ts": "test\n",
  "packages/adapter-pi/extensions/workbench.ts": "export default () => {}\n",
  "packages/adapter-pi/src/index.ts": "export {}\n",
  "resources/skills/latex-project/SKILL.md": "# skill\n",
  "resources/fixtures/sample.tex": "fixture\n",
  "migrations/0001_init.sql": "create table x();\n",
  "runtime/presets/local.json": "{}\n",
  "runtime/toolchain/bundle/huge.tar": "nope\n",
  "runtime/render/bin/helper": "nope\n",
  "fixtures/index.json": "{}\n",
  "results/run/outcome.json": "{}\n",
  "design/spec.md": "spec\n",
  "scripts/generate-types.py": "print()\n",
  "docs/EVAL.md": "eval\n",
  ".github/workflows/ci.yml": "ci\n",
}

const EXPECTED_SELECTION = [
  ...VENDOR_EXACT_PATHS,
  "packages/adapter-pi/extensions/workbench.ts",
  "packages/adapter-pi/src/index.ts",
  "packages/cli/package.json",
  "packages/cli/src/bin.ts",
  "packages/cli/tsconfig.json",
  "resources/skills/latex-project/SKILL.md",
  "migrations/0001_init.sql",
  "runtime/presets/local.json",
].sort()

const PLUGIN_JSON = `{
  "id": "fixture",
  "capabilities": ["skills"],
  "bundle_include": ["README.md"],
  "i18n": { "locales": { "en": {} } }
}
`

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-09-25T00:55:12+08:00",
      GIT_COMMITTER_DATE: "2026-09-25T00:55:12+08:00",
    },
  }).trim()
}

describe("vendor path selection", () => {
  it("selects exactly the documented rules and nothing excluded", () => {
    expect(selectVendorPaths(Object.keys(UPSTREAM_FILES))).toEqual(EXPECTED_SELECTION)
  })

  it.each([
    "packages/core/test/m1.integration.test.ts",
    "resources/fixtures/x.tex",
    "packages/contracts/schemas/project.schema.json",
    "runtime/toolchain-lock.json.bak",
    "runtime/toolchain/bundle/x",
    "runtime/render/manifest.json",
    "design/pi-latex-workbench-v2/README.md",
    "scripts/pi-canary.sh",
    "results/pi-live/events.json",
    "docs/ACCEPTANCE.md",
  ])("excludes %s", (path) => {
    expect(isVendorPath(path)).toBe(false)
  })

  it("refuses an upstream tree that lost a required file", () => {
    const paths = Object.keys(UPSTREAM_FILES).filter((path) => path !== "runtime/host-policy.json")
    expect(() => selectVendorPaths(paths)).toThrow(/runtime\/host-policy\.json/)
  })
})

describe("derived files", () => {
  it("hashes like `git hash-object`", () => {
    expect(gitBlobSha1(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
    expect(gitBlobSha1("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
  })

  it("orders the bundle allowlist docs → glue → vendor", () => {
    expect(
      computeBundleInclude({
        pluginFiles: ["skills/a/SKILL.md", "pi/x.ts"],
        vendorPaths: ["b", "a"],
      })
    ).toEqual([...BUNDLE_DOCS, "pi/x.ts", "skills/a/SKILL.md", "vendor/a", "vendor/b"])
  })

  it("rewrites only the bundle_include block, one entry per line", () => {
    const next = replaceBundleInclude(PLUGIN_JSON, ["a.md", "vendor/b.ts"])
    expect(JSON.parse(next)).toEqual({
      ...JSON.parse(PLUGIN_JSON),
      bundle_include: ["a.md", "vendor/b.ts"],
    })
    expect(next).toContain('  "bundle_include": [\n    "a.md",\n    "vendor/b.ts"\n  ],')
    expect(next).toContain('"capabilities": ["skills"]')
    expect(replaceBundleInclude(next, ["a.md", "vendor/b.ts"])).toBe(next)
    expect(() => replaceBundleInclude("{}", [])).toThrow(/bundle_include/)
  })

  it("renders VENDOR.md with provenance, the path rules and the license note", () => {
    const doc = renderVendorDoc({
      commit: "95e8a6d2838e38bd66766edf677fedfe4db53cac",
      commitDate: "2026-09-25T00:55:12+08:00",
      files: { "README.md": "x" },
    })
    expect(doc).toContain(UPSTREAM_URL)
    expect(doc).toContain("`95e8a6d2838e38bd66766edf677fedfe4db53cac`")
    expect(doc).toContain("`packages/*/src/**`")
    expect(doc).toContain("no LICENSE file")
    expect(doc).toContain("confirmed with the upstream owner")
  })
})

describe("the in-tree snapshot", () => {
  it("matches vendor-lock.json, VENDOR.md and the plugin.json allowlist byte-for-byte", () => {
    expect(checkVendor({ pluginRoot })).toEqual([])
  })

  it("is pinned to upstream commit 95e8a6d", () => {
    const lock = JSON.parse(readFileSync(join(pluginRoot, LOCK_FILE), "utf8"))
    expect(lock.commit).toBe("95e8a6d2838e38bd66766edf677fedfe4db53cac")
    expect(lock.upstream).toBe(UPSTREAM_URL)
    expect(Object.keys(lock.files).every((path) => isVendorPath(path))).toBe(true)
  })
})

describe("syncVendor against a real git repository", () => {
  let scratch: string
  let upstream: string
  let plugin: string
  let commit: string

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "pi-latex-sync-"))
    upstream = join(scratch, "upstream")
    plugin = join(scratch, "plugin")
    for (const [path, body] of Object.entries(UPSTREAM_FILES)) write(upstream, path, body)
    git(upstream, "init", "-q")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-q", "-m", "snapshot")
    commit = git(upstream, "rev-parse", "HEAD")
    // Uncommitted working-tree state must never reach the snapshot.
    write(upstream, "README.md", "dirty working tree\n")
    write(upstream, "packages/cli/src/untracked.ts", "untracked\n")

    write(plugin, "plugin.json", PLUGIN_JSON)
    write(plugin, "assets/icon.png", "plugin icon\n")
    write(plugin, "pi/glue.ts", "export {}\n")
    write(plugin, "pi/glue.test.ts", "test\n")
    write(plugin, "skills/s/SKILL.md", "# s\n")
    write(plugin, "vendor/stale/file.ts", "from an older snapshot\n")
    write(plugin, "vendor/node_modules/ajv/index.js", "installed by prepare\n")
    write(plugin, "vendor/runtime/toolchain/bundle/big", "provisioned\n")
  })

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it("extracts the committed archive, prunes stale files and keeps local-only dirs", () => {
    const result = syncVendor({ pluginRoot: plugin, upstream, ref: "HEAD" })
    expect(JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8")).bundle_include).toContain(
      "assets/icon.png"
    )
    expect(result).toEqual({
      commit,
      commitDate: "2026-09-25T00:55:12+08:00",
      files: EXPECTED_SELECTION.length,
    })
    expect(listVendorFiles(join(plugin, "vendor"))).toEqual(EXPECTED_SELECTION)
    expect(readFileSync(join(plugin, "vendor/README.md"), "utf8")).toBe("exact README.md\n")
    expect(existsSync(join(plugin, "vendor/stale"))).toBe(false)
    expect(existsSync(join(plugin, "vendor/packages/cli/src/untracked.ts"))).toBe(false)
    expect(existsSync(join(plugin, "vendor/node_modules/ajv/index.js"))).toBe(true)
    expect(existsSync(join(plugin, "vendor/runtime/toolchain/bundle/big"))).toBe(true)
  })

  it("writes the lock, VENDOR.md and the bundle allowlist from the selection", () => {
    const lock = JSON.parse(readFileSync(join(plugin, LOCK_FILE), "utf8"))
    expect(lock.commit).toBe(commit)
    expect(lock.files["packages/cli/src/bin.ts"]).toBe(
      git(upstream, "rev-parse", `${commit}:packages/cli/src/bin.ts`)
    )
    expect(readFileSync(join(plugin, "VENDOR.md"), "utf8")).toContain(commit)
    const manifest = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"))
    expect(manifest.bundle_include).toEqual([
      ...BUNDLE_DOCS,
      "assets/icon.png",
      "pi/glue.ts",
      "skills/s/SKILL.md",
      ...EXPECTED_SELECTION.map((path) => `vendor/${path}`),
    ])
  })

  it("verifies clean offline and against the upstream commit", () => {
    expect(checkVendor({ pluginRoot: plugin })).toEqual([])
    expect(checkVendor({ pluginRoot: plugin, upstream })).toEqual([])
  })

  it("is byte-identical when re-run for the same commit", () => {
    const before = ["plugin.json", LOCK_FILE, "VENDOR.md"].map((f) =>
      readFileSync(join(plugin, f), "utf8")
    )
    syncVendor({ pluginRoot: plugin, upstream, ref: commit })
    expect(
      ["plugin.json", LOCK_FILE, "VENDOR.md"].map((f) => readFileSync(join(plugin, f), "utf8"))
    ).toEqual(before)
  })

  it("reports edited, missing and unrecorded vendor files and a stale allowlist", () => {
    write(plugin, "vendor/packages/cli/src/bin.ts", "patched for Cognia\n")
    rmSync(join(plugin, "vendor/migrations/0001_init.sql"))
    write(plugin, "vendor/packages/cli/src/extra.ts", "added\n")
    write(plugin, "skills/s/references/new.md", "unlisted glue\n")
    const problems = checkVendor({ pluginRoot: plugin })
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^modified vendored file: packages\/cli\/src\/bin\.ts/),
        "missing vendored file: migrations/0001_init.sql",
        "unrecorded file in vendor/: packages/cli/src/extra.ts",
        "plugin.json bundle_include does not match the vendored + glue file set",
      ])
    )
  })

  it("catches a lock that does not describe the recorded commit", () => {
    syncVendor({ pluginRoot: plugin, upstream, ref: commit })
    const lockPath = join(plugin, LOCK_FILE)
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    const forged = { ...lock, files: { ...lock.files, "README.md": gitBlobSha1("forged\n") } }
    writeFileSync(lockPath, `${JSON.stringify(forged, null, 2)}\n`)
    write(plugin, "vendor/README.md", "forged\n")
    expect(checkVendor({ pluginRoot: plugin, upstream })).toEqual(
      expect.arrayContaining([`lock disagrees with ${commit} for README.md`])
    )
  })
})
