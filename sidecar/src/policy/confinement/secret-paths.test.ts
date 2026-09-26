// Workspace confinement (ADR-0028 "lite"): the protected credential paths.

import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

import { isSecretPath } from "./secret-paths.ts"

test("isSecretPath flags credential directories and files", () => {
  assert.equal(isSecretPath(path.join(os.homedir(), ".ssh", "id_rsa")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".aws", "credentials")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".git-credentials")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".npmrc")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".config", "gh", "hosts.yml")), true)
  // Rust-protected Cognia app-data dirs (parity with protected.rs).
  assert.equal(isSecretPath(path.join(os.homedir(), ".config", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".local", "share", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), ".cargo", "credentials.toml")), true)
  assert.equal(
    isSecretPath(path.join(os.homedir(), "Library", "Application Support", "cognia", "x")),
    true
  )
  assert.equal(isSecretPath(path.join(os.homedir(), "AppData", "Roaming", "cognia", "x")), true)
  assert.equal(isSecretPath(path.join(os.homedir(), "AppData", "Local", "cognia", "x")), true)
})

test("isSecretPath does NOT flag .env or ordinary project files", () => {
  assert.equal(isSecretPath(path.join(os.tmpdir(), "proj", ".env")), false)
  assert.equal(isSecretPath(path.join(os.tmpdir(), "proj", "src", "index.ts")), false)
  assert.equal(isSecretPath(""), false)
})
