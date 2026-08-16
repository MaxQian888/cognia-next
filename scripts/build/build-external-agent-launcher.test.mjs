import assert from "node:assert/strict"
import { test } from "node:test"

import {
  LAUNCHER_BIN,
  launcherPaths,
  prepareExternalAgentLauncher,
} from "./build-external-agent-launcher.mjs"

test("launcherPaths follows Tauri's target-suffixed external binary contract", () => {
  assert.deepEqual(launcherPaths("/repo", "aarch64-apple-darwin"), {
    source: "/repo/target/release/cognia-external-agent-launcher",
    destination:
      "/repo/src-tauri/binaries/cognia-external-agent-launcher-aarch64-apple-darwin",
  })
  assert.deepEqual(launcherPaths("C:/repo", "x86_64-pc-windows-msvc", "C:/target"), {
    source: "C:/target/release/cognia-external-agent-launcher.exe",
    destination:
      "C:/repo/src-tauri/binaries/cognia-external-agent-launcher-x86_64-pc-windows-msvc.exe",
  })
})

test("the staged binary name matches what sandbox.rs looks for", () => {
  // `launcher_file_name` in crates/cognia-external-agent/src/sandbox.rs resolves
  // this exact basename next to the app executable. A rename on either side
  // makes every desktop external-agent session fail closed.
  assert.equal(LAUNCHER_BIN, "cognia-external-agent-launcher")
})

test("prepareExternalAgentLauncher builds the launcher bin from the automation crate", () => {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    if (command === "rustc") {
      return { status: 0, stdout: "host: aarch64-apple-darwin\n" }
    }
    // Stop before the copy: the source artifact does not exist in a unit test.
    return { status: 1 }
  }

  assert.throws(
    () => prepareExternalAgentLauncher({ root: "/repo", target: undefined, run }),
    /building cognia-external-agent-launcher failed/
  )

  assert.deepEqual(calls[0], { command: "rustc", args: ["-vV"] })
  assert.deepEqual(calls[1], {
    command: "cargo",
    args: [
      "build",
      "-p",
      "cognia-automation",
      "--bin",
      "cognia-external-agent-launcher",
      "--release",
    ],
  })
})

test("an explicit target triple is passed through to cargo for cross builds", () => {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    return { status: 1 }
  }

  assert.throws(
    () =>
      prepareExternalAgentLauncher({
        root: "/repo",
        target: "x86_64-unknown-linux-gnu",
        run,
      }),
    /failed/
  )

  // No rustc probe when the caller already knows the triple.
  assert.equal(calls[0].command, "cargo")
  assert.deepEqual(calls[0].args.slice(-2), ["--target", "x86_64-unknown-linux-gnu"])
})
