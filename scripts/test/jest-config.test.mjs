import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"

import buildConfig from "../../jest.config.ts"

const config = await buildConfig()
const root = process.cwd().replaceAll("\\", "/")

test("AI SDK stays transformable at native pnpm module boundaries", () => {
  const child = spawnSync(process.execPath, ["node_modules/jest/bin/jest.js", "--showConfig"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30000,
  })
  assert.equal(child.status, 0, child.stderr)
  const resolved = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")))
  for (const project of resolved.configs) {
    const ignored = (file) =>
      project.transformIgnorePatterns.some((pattern) => new RegExp(pattern).test(file))
    assert.equal(
      ignored(
        path.join(
          process.cwd(),
          "node_modules",
          ".pnpm",
          "ai@7.0.128",
          "node_modules",
          "ai",
          "dist",
          "index.js"
        )
      ),
      false
    )
    assert.equal(ignored(path.join(process.cwd(), "node_modules", "ai", "dist", "index.js")), false)
    assert.equal(
      ignored(
        path.join(
          process.cwd(),
          "node_modules",
          ".pnpm",
          "tailwindcss@4",
          "node_modules",
          "tailwindcss",
          "dist",
          "index.js"
        )
      ),
      true
    )
  }
})

function isHidden(project, file) {
  return project.modulePathIgnorePatterns.some((pattern) =>
    new RegExp(pattern.replaceAll("<rootDir>", root)).test(`${root}/${file}`)
  )
}

test("all Jest projects keep temporary and generated native output out of the file index", () => {
  for (const project of config.projects) {
    for (const file of [
      ".tmp/cli-probe/bundle.js",
      ".tmp/cli-probe/example.test.ts",
      ".codex-tmp/audit/example.test.ts",
      ".next-mobile-dev/dev/server/chunk.js",
      "dist/ios/App/public/chunk.js",
      "mobile/android/app/build/intermediates/metadata.json",
      "mobile/ios/App/App/public/chunk.js",
    ]) {
      assert.equal(isHidden(project, file), true, `${project.displayName}: ${file}`)
    }
    for (const file of [
      "lib/connectors/runtime.test.ts",
      "components/mobile/shell.test.tsx",
      "hooks/use-mobile.test.ts",
      "packages/agent/src/index.test.ts",
    ]) {
      assert.equal(isHidden(project, file), false, `${project.displayName}: ${file}`)
    }
  }
})

function readBudget({ cores = 14, freeGb = 48, totalGb = 48, ci = false, coverage = false }) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import os from "node:os";
    os.cpus = () => Array(${cores}).fill({});
    os.freemem = () => ${freeGb} * 1e9;
    os.totalmem = () => ${totalGb} * 1e9;
    const { default: buildConfig } = await import("./jest.config.ts");
    const config = await buildConfig();
    console.log(JSON.stringify({ maxWorkers: config.maxWorkers, idleLimit: config.workerIdleMemoryLimit }));
  `,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CI: ci ? "1" : "", JEST_COVERAGE: coverage ? "1" : "" },
      timeout: 30_000,
    }
  )
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout.slice(child.stdout.indexOf("{")))
}

test("local worker budget stays conservative and follows available memory", () => {
  assert.equal(readBudget({}).maxWorkers, 2)
  assert.equal(readBudget({ freeGb: 0.2 }).maxWorkers, 1)
  assert.equal(readBudget({ cores: 1 }).maxWorkers, 1)
})

test("CI and coverage workers respect both CPU and memory budgets", () => {
  assert.equal(readBudget({ cores: 64, totalGb: 128, freeGb: 128, ci: true }).maxWorkers, 4)
  assert.equal(readBudget({ cores: 64, freeGb: 6, ci: true }).maxWorkers, 2)
  assert.equal(readBudget({ cores: 64, freeGb: 0.2, ci: true }).maxWorkers, 1)
  assert.equal(readBudget({ cores: 64, freeGb: 5, ci: true, coverage: true }).maxWorkers, 2)
  assert.equal(readBudget({ freeGb: 0.2, coverage: true }).maxWorkers, 1)
  assert.equal(readBudget({ coverage: true }).idleLimit, "768MB")
})

test("an explicit Jest CLI worker budget overrides the default", () => {
  const child = spawnSync(
    process.execPath,
    ["node_modules/jest/bin/jest.js", "--showConfig", "--maxWorkers=3"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout.slice(child.stdout.indexOf("{"))).globalConfig.maxWorkers, 3)
})

test("Jest configuration resolves source modules from the repository root", () => {
  for (const project of config.projects) {
    assert.equal(project.moduleNameMapper["^@/(.*)$"], "<rootDir>/$1")
  }
  assert.equal(
    path.resolve(config.testSequencer),
    path.join(process.cwd(), "scripts/test/jest-timing-sequencer.cjs")
  )
})

test("default Jest keeps heavy checks, while unit projects cannot collect them twice", () => {
  assert.deepEqual(
    config.projects.map((project) => project.displayName),
    ["node", "jsdom", "heavy", "build", "pty"]
  )
  for (const project of config.projects.slice(0, 2)) {
    for (const file of [
      "components/chat/markdown-renderer.heavy.test.ts",
      "cli/src/agent/subagent-background-tasks.heavy.test.ts",
    ]) {
      assert.equal(
        project.testPathIgnorePatterns.some((pattern) => new RegExp(pattern).test(file)),
        true
      )
    }
  }
  assert.equal(config.projects[2].testEnvironment, "node")
  assert.equal(config.collectCoverage, false)
})

test("build and real PTY suites stay in default validation but outside unit projects", () => {
  for (const name of ["build", "pty"]) {
    assert.ok(
      config.projects.some((project) => project.displayName === name),
      `${name} is included`
    )
  }
  for (const file of [
    "cli/src/cli/entry.bundle.test.ts",
    "cli/src/cli/coding-loop.bundle.test.ts",
    "cli/src/tui/pty/conversation-driver.test.ts",
    "cli/src/tui/pty/node-pty-harness.test.ts",
    "cli/src/tui/pty/conversation-control.test.ts",
  ]) {
    for (const project of config.projects.slice(0, 2)) {
      assert.equal(
        project.testPathIgnorePatterns.some((pattern) =>
          new RegExp(pattern).test(`${root}/${file}`)
        ),
        true,
        `${project.displayName}: ${file}`
      )
    }
  }
  for (const file of ["terminal-screen.test.ts", "a-new-helper.test.ts"]) {
    const node = config.projects.find((project) => project.displayName === "node")
    assert.equal(
      node.testPathIgnorePatterns.some((pattern) =>
        new RegExp(pattern).test(`${root}/cli/src/tui/pty/${file}`)
      ),
      false,
      `${file} remains a unit test`
    )
  }
})
