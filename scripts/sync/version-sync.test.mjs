/**
 * Coverage for scripts/sync/version-sync.mjs — the pure version helpers.
 *
 * Run with: node --test scripts/sync/version-sync.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  TARGETS,
  isValidVersion,
  extractVersion,
  replaceVersion,
  parseArgs,
  getAndroidVersion,
  getIosVersion,
  isVersionSynced,
} from "./version-sync.mjs"

const iosProject = () =>
  readFileSync(
    new URL("../../mobile/ios/App/App.xcodeproj/project.pbxproj", import.meta.url),
    "utf8"
  )

test("iOS uses numeric marketing versions and ordered four-digit build stages", () => {
  for (const [suffix, buildVersion] of [
    ["-alpha.0", "1"],
    ["-alpha.499", "500"],
    ["-beta.0", "501"],
    ["-beta.499", "1000"],
    ["-rc.0", "1001"],
    ["-rc.499", "1500"],
    ["", "1999"],
  ]) {
    assert.deepEqual(getIosVersion(`99.99.99${suffix}`), {
      marketingVersion: "99.99.99",
      buildVersion,
    })
  }
  for (const invalid of ["1.2.3+build.1", "1.2.3-preview.1", "1.2.3-rc.500", "100.0.0"])
    assert.throws(() => getIosVersion(invalid))
})

test("iOS updates only configurations referenced by the App target", () => {
  const original = iosProject().replace(
    "/* End XCBuildConfiguration section */",
    "\t\tEEEEEEEEEEEEEEEEEEEEEEEE /* Unrelated */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tMARKETING_VERSION = 9.8.7;\n\t\t\t\tCURRENT_PROJECT_VERSION = 42;\n\t\t\t};\n\t\t\tname = Release;\n\t\t};\n/* End XCBuildConfiguration section */"
  )
  const updated = replaceVersion(original, "ios-project", "2.3.4-beta.7")
  assert.equal(extractVersion(updated, "ios-project"), "2.3.4")
  assert.equal(isVersionSynced(updated, "ios-project", "2.3.4-beta.7"), true)
  assert.equal(
    isVersionSynced(
      updated.replace("CURRENT_PROJECT_VERSION = 508;", "CURRENT_PROJECT_VERSION = 509;"),
      "ios-project",
      "2.3.4-beta.7"
    ),
    false
  )
  assert.equal(
    isVersionSynced(
      updated.replace("MARKETING_VERSION = 2.3.4;", "MARKETING_VERSION = 2.3.5;"),
      "ios-project",
      "2.3.4-beta.7"
    ),
    false
  )
  assert.equal((updated.match(/MARKETING_VERSION = 2.3.4;/g) ?? []).length, 2)
  assert.equal((updated.match(/CURRENT_PROJECT_VERSION = 508;/g) ?? []).length, 2)
  assert.equal(
    updated
      .replaceAll("MARKETING_VERSION = 2.3.4;", "MARKETING_VERSION = sentinel;")
      .replaceAll("CURRENT_PROJECT_VERSION = 508;", "CURRENT_PROJECT_VERSION = sentinel;"),
    original
      .replace(/MARKETING_VERSION = (?!9\.8\.7)[^;]+;/g, "MARKETING_VERSION = sentinel;")
      .replace(/CURRENT_PROJECT_VERSION = (?!42;)[^;]+;/g, "CURRENT_PROJECT_VERSION = sentinel;")
  )
})

test("iOS rejects missing, duplicate and unresolvable target settings", () => {
  for (const corrupt of [
    iosProject().replace(/\s+MARKETING_VERSION = [^;]+;/, ""),
    iosProject().replace(
      /CURRENT_PROJECT_VERSION = [^;]+;/,
      "$&\n\t\t\t\tCURRENT_PROJECT_VERSION = 2;"
    ),
    iosProject().replace("name = App;", "name = Other;"),
    iosProject().replace(
      "504EC3171FED79650016851F /* Debug */,",
      "EEEEEEEEEEEEEEEEEEEEEEEE /* Debug */,"
    ),
  ])
    assert.throws(() => replaceVersion(corrupt, "ios-project", "0.1.0"), /iOS/)
})

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("isValidVersion accepts semver and semver with pre/build tails", () => {
  assert.ok(isValidVersion("0.1.0"))
  assert.ok(isValidVersion("12.34.56"))
  assert.ok(isValidVersion("1.2.3-beta.1"))
  assert.ok(isValidVersion("1.2.3+build.9"))
})

test("isValidVersion rejects malformed versions", () => {
  assert.ok(!isValidVersion("1.2"))
  assert.ok(!isValidVersion("v1.2.3"))
  assert.ok(!isValidVersion(""))
  assert.ok(!isValidVersion(undefined))
  assert.ok(!isValidVersion(123))
  for (const version of ["01.2.3", "1.2.3-", "1.2.3-alpha.01", "1.2.3+foo..bar"]) {
    assert.ok(!isValidVersion(version), version)
  }
})

test("Android codes preserve prerelease and release ordering across tuple boundaries", () => {
  const ordered = [
    "0.0.0-alpha.0",
    "0.0.0-alpha.499",
    "0.0.0-beta.0",
    "0.0.0-beta.499",
    "0.0.0-rc.0",
    "0.0.0-rc.499",
    "0.0.0",
    "0.0.1-alpha.0",
    "0.99.99",
    "1.0.0-alpha.0",
    "99.99.99",
  ]
  const codes = ordered.map((version) => getAndroidVersion(version).versionCode)
  assert.equal(codes[0], 1)
  assert.equal(codes.at(-1), 1_999_999_999)
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1])
  assert.deepEqual(getAndroidVersion("0.1.0"), { versionName: "0.1.0", versionCode: 201999 })
})

test("Android versions reject overflow and colliding or unsupported suffixes", () => {
  for (const version of [
    "100.0.0",
    "0.100.0",
    "0.0.100",
    "1.2.3-alpha.500",
    "1.2.3-beta",
    "1.2.3-preview.1",
    "1.2.3+build.9",
    "1.2.3-rc.01",
    "01.2.3",
    "bad",
  ]) {
    assert.throws(() => getAndroidVersion(version), /Android version/, version)
  }
})

test("Android properties synchronize both version fields while preserving comments", () => {
  const original = "# generated\nversionName=0.1.0\nversionCode=1\n"
  assert.equal(extractVersion(original, "android-properties"), "0.1.0")
  assert.equal(isVersionSynced(original, "android-properties", "0.1.0"), false)
  const updated = replaceVersion(original, "android-properties", "0.1.0")
  assert.equal(updated, "# generated\nversionName=0.1.0\nversionCode=201999\n")
  assert.equal(isVersionSynced(updated, "android-properties", "0.1.0"), true)
  assert.equal(isVersionSynced(updated, "android-properties", "0.2.0"), false)
  assert.equal(replaceVersion(updated, "android-properties", "0.1.0"), updated)
  assert.throws(
    () => replaceVersion("versionName=0.1.0\n", "android-properties", "0.1.0"),
    /versionCode/
  )
  assert.throws(
    () => replaceVersion(updated + "versionCode=1\n", "android-properties", "0.1.0"),
    /versionCode/
  )
})

test("CLI check rejects code-only drift and sync repairs it without changing the name", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cognia-version-sync-"))
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  try {
    mkdirSync(join(fixture, "scripts/sync"), { recursive: true })
    const script = join(fixture, "scripts/sync/version-sync.mjs")
    copyFileSync(join(repository, "scripts/sync/version-sync.mjs"), script)
    symlinkSync(join(repository, "node_modules"), join(fixture, "node_modules"), "dir")
    writeFileSync(join(fixture, "package.json"), '{"version":"0.1.0"}')
    for (const target of TARGETS) {
      const path = join(fixture, target.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        target.kind === "cargo"
          ? 'version = "0.1.0"\n'
          : target.kind === "android-properties"
            ? "versionName=0.1.0\nversionCode=1\n"
            : target.kind === "ios-project"
              ? iosProject()
              : '{"version":"0.1.0"}\n'
      )
    }
    const check = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" })
    assert.equal(check.status, 1)
    assert.match(check.stderr, /version\.properties.*expected versionCode 201999/)
    const sync = spawnSync(process.execPath, [script], { encoding: "utf8" })
    assert.equal(sync.status, 0, sync.stderr)
    assert.equal(
      readFileSync(join(fixture, "mobile/android/version.properties"), "utf8"),
      "versionName=0.1.0\nversionCode=201999\n"
    )
    assert.equal(spawnSync(process.execPath, [script, "--check"]).status, 0)
    const iosPath = join(fixture, "mobile/ios/App/App.xcodeproj/project.pbxproj")
    writeFileSync(
      iosPath,
      readFileSync(iosPath, "utf8").replace(
        /CURRENT_PROJECT_VERSION = [^;]+;/,
        "CURRENT_PROJECT_VERSION = 1;"
      )
    )
    assert.equal(spawnSync(process.execPath, [script, "--check"]).status, 1)
    writeFileSync(
      iosPath,
      readFileSync(iosPath, "utf8").replace(/\s+MARKETING_VERSION = [^;]+;/, "")
    )
    writeFileSync(join(fixture, "package.json"), '{"version":"0.1.1"}')
    assert.equal(spawnSync(process.execPath, [script]).status, 1)
    assert.equal(
      readFileSync(join(fixture, "src-tauri/tauri.conf.json"), "utf8"),
      '{"version":"0.1.0"}\n',
      "malformed later targets must not partially update earlier mirrors"
    )
    writeFileSync(join(fixture, "package.json"), '{"version":"0.1.1+build.1"}')
    const invalid = spawnSync(process.execPath, [script], { encoding: "utf8" })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /Unsupported Android version/)
    assert.equal(
      readFileSync(join(fixture, "mobile/package.json"), "utf8"),
      '{"version":"0.1.0"}\n'
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("extractVersion reads the top-level field from JSON", () => {
  const json = '{\n  "name": "x",\n  "version": "1.4.2",\n  "private": true\n}\n'
  assert.equal(extractVersion(json, "json"), "1.4.2")
})

test("extractVersion reads the [package] version from Cargo.toml", () => {
  const cargo = '[package]\nname = "x"\nversion = "2.0.1"\nedition = "2021"\n'
  assert.equal(extractVersion(cargo, "cargo"), "2.0.1")
})

test("extractVersion returns null when no version literal exists", () => {
  assert.equal(extractVersion('{\n  "name": "x"\n}\n', "json"), null)
  assert.equal(extractVersion('[package]\nname = "x"\n', "cargo"), null)
})

test("replaceVersion rewrites the JSON top-level field only", () => {
  const json = '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": { "dep": "1.0.0" }\n}\n'
  const out = replaceVersion(json, "json", "9.9.9")
  assert.match(out, /"version": "9\.9\.9"/)
  // The dependency's version literal (not a "version": field) is untouched.
  assert.match(out, /"dep": "1\.0\.0"/)
})

test("replaceVersion rewrites only the first (package) version in Cargo.toml", () => {
  const cargo =
    '[package]\nname = "x"\nversion = "1.0.0"\n\n[dependencies]\nserde = "1.0.0"\nother = { version = "3.2.1" }\n'
  const out = replaceVersion(cargo, "cargo", "9.9.9")
  assert.match(out, /^version = "9\.9\.9"$/m)
  // Dependency versions use `name = "…"` / inline tables, never a line-start
  // `version = "…"`, so they are left intact.
  assert.match(out, /serde = "1\.0\.0"/)
  assert.match(out, /other = \{ version = "3\.2\.1" \}/)
})

test("replaceVersion is idempotent", () => {
  const json = '{\n  "version": "5.5.5"\n}\n'
  assert.equal(replaceVersion(json, "json", "5.5.5"), json)
})

test("replaceVersion is a no-op when no version literal is present", () => {
  const content = '{\n  "name": "x"\n}\n'
  assert.equal(replaceVersion(content, "json", "1.0.0"), content)
})

test("TARGETS covers the app-version group and excludes independent packages", () => {
  const paths = TARGETS.map((t) => t.path)
  // App group present.
  assert.ok(paths.includes("src-tauri/tauri.conf.json"))
  assert.ok(paths.includes("src-tauri/Cargo.toml"))
  assert.ok(paths.includes("cli/package.json"))
  assert.ok(paths.includes("sidecar/package.json"))
  assert.ok(paths.includes("crates/cognia-sidecar/Cargo.toml"))
  assert.ok(paths.includes("mobile/package.json"))
  assert.ok(paths.includes("mobile/android/version.properties"))
  assert.ok(paths.includes("mobile/ios/App/App.xcodeproj/project.pbxproj"))
  // Independently-versioned things must NOT be swept in.
  assert.ok(!paths.some((p) => p.startsWith("services/")))
  assert.ok(!paths.some((p) => p.includes("plugin-template")))
  assert.ok(!paths.includes("packages/plugin-sdk/package.json"))
  // Every target declares a known kind.
  for (const t of TARGETS) {
    assert.ok(
      ["json", "cargo", "android-properties", "ios-project"].includes(t.kind),
      `bad kind for ${t.path}`
    )
  }
})
