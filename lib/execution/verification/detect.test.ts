import { detectVerificationRunner } from "./detect"

const bash = (command: string) => detectVerificationRunner("Bash", { command })

describe("recognises the runners", () => {
  it.each([
    ["pnpm test -- lib/execution", "package-script"],
    ["npm run test:e2e", "package-script"],
    ["yarn test --watch=false", "package-script"],
    ["npx jest lib/foo.test.ts", "jest"],
    ["jest --coverage", "jest"],
    ["pnpm exec vitest run", "vitest"],
    ["npx playwright test --project=chromium", "playwright"],
    ["cargo test --manifest-path src-tauri/Cargo.toml", "cargo-test"],
    ["cargo +nightly test", "cargo-test"],
    ["cargo nextest run", "cargo-test"],
  ])("%s → %s", (command, expected) => {
    expect(bash(command)).toBe(expected)
  })

  it("finds a test invocation later in a chained command", () => {
    expect(bash("pnpm i18n:build && npx jest lib/")).toBe("jest")
  })
})

describe("declines what is not a test run", () => {
  it.each([
    'git commit -m "fix a jest flake"',
    'rg "vitest" --glob "*.ts"',
    "echo test",
    "ls tests/",
    "cargo build",
    "cargo fmt --all --check",
  ])("%s", (command) => {
    expect(bash(command)).toBeNull()
  })

  it("ignores non-shell tools even when the input mentions a runner", () => {
    expect(detectVerificationRunner("Edit", { command: "jest" })).toBeNull()
    expect(detectVerificationRunner("Write", { content: "cargo test" })).toBeNull()
  })

  it("ignores a shell call with no command", () => {
    expect(detectVerificationRunner("Bash", {})).toBeNull()
    expect(detectVerificationRunner("Bash", { command: "   " })).toBeNull()
    expect(detectVerificationRunner("Bash", undefined)).toBeNull()
  })

  it("ignores a missing tool name", () => {
    expect(detectVerificationRunner(undefined, { command: "jest" })).toBeNull()
  })
})
