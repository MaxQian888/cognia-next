import {
  classifyWorkspacePath,
  commandTouchesSecretPath,
  isSecretWorkspacePath,
} from "./path-policy"

describe("classifyWorkspacePath", () => {
  it.each([
    ".env",
    "apps/web/.env.local",
    ".envrc",
    ".npmrc",
    "keys/server.pem",
    "id_rsa",
    "id_rsa.pub",
    ".git/config",
    ".git",
    "home/.ssh/config",
    ".aws/credentials",
    ".config/gh/hosts.yml",
    ".git-credentials",
    "credentials.json",
  ])("treats %s as secret", (path) => {
    expect(classifyWorkspacePath(path)).toBe("secret")
  })

  it.each([
    "node_modules/react/index.js",
    "target/debug/app",
    "packages/x/dist/a.js",
    "node_modules",
  ])("treats %s as a bulk tree", (path) => {
    expect(classifyWorkspacePath(path)).toBe("bulk")
  })

  it.each(["src/index.ts", ".gitignore", ".github/workflows/ci.yml", "README.md", ""])(
    "treats %s as ordinary",
    (path) => {
      expect(classifyWorkspacePath(path)).toBe("ordinary")
    }
  )

  it("secret outranks bulk", () => {
    expect(classifyWorkspacePath("node_modules/pkg/.env")).toBe("secret")
  })

  it("folds case and backslashes", () => {
    expect(isSecretWorkspacePath("Config\\.SSH\\id_ed25519")).toBe(true)
  })
})

describe("commandTouchesSecretPath", () => {
  it("flags commands that name a credential path", () => {
    expect(commandTouchesSecretPath("cat .env")).toBe(true)
    expect(commandTouchesSecretPath("grep token ~/.aws/credentials")).toBe(true)
    expect(commandTouchesSecretPath('cp "keys/prod.key" /tmp')).toBe(true)
  })

  it("leaves ordinary commands and flags alone", () => {
    expect(commandTouchesSecretPath("pnpm test --env=ci")).toBe(false)
    expect(commandTouchesSecretPath("git status")).toBe(false)
  })
})
