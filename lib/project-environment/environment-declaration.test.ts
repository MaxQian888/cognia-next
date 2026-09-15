import { parseDevcontainer } from "./devcontainer"
import {
  environmentDeclarationDigest,
  isValidEgressDomainPattern,
  normalizeCommand,
  normalizeEgressDomains,
  normalizeEnv,
  normalizePorts,
  normalizeUser,
  type DeclarationProblem,
  type EnvironmentDeclaration,
} from "./environment-declaration"

function declaration(
  text: string,
  path = ".devcontainer/devcontainer.json"
): EnvironmentDeclaration {
  const result = parseDevcontainer(text, path)
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result.declaration
}

const identity = (text: string) => text

describe("environmentDeclarationDigest", () => {
  const base = `{ "image": "node:22", "postCreateCommand": "npm ci", "forwardPorts": [3000] }`

  it("ignores formatting, comments, key order and fields Cognia ignores", async () => {
    const digest = await environmentDeclarationDigest(declaration(base))
    const reformatted = `{
      // same content, different text
      "forwardPorts": [ 3000, ],
      "postCreateCommand": "npm ci",
      "image": "docker.io/library/node:22",
      "name": "renamed",
      "customizations": { "vscode": {} },
    }`
    await expect(environmentDeclarationDigest(declaration(reformatted))).resolves.toBe(digest)
  })

  it("changes with every runtime field, the image and the path", async () => {
    const digest = await environmentDeclarationDigest(declaration(base))
    const variants = [
      `{ "image": "node:23", "postCreateCommand": "npm ci", "forwardPorts": [3000] }`,
      `{ "image": "node:22", "postCreateCommand": "npm i", "forwardPorts": [3000] }`,
      `{ "image": "node:22", "postCreateCommand": "npm ci", "forwardPorts": [3001] }`,
      `{ "image": "node:22", "postCreateCommand": "npm ci", "forwardPorts": [3000], "remoteUser": "node" }`,
      `{ "image": "node:22", "postCreateCommand": "npm ci", "forwardPorts": [3000], "containerEnv": { "A": "1" } }`,
    ]
    const digests = await Promise.all(
      variants.map((text) => environmentDeclarationDigest(declaration(text)))
    )
    expect(new Set([digest, ...digests]).size).toBe(variants.length + 1)
    await expect(
      environmentDeclarationDigest(declaration(base, ".devcontainer/other/devcontainer.json"))
    ).resolves.not.toBe(digest)
  })

  it("is a lowercase hex sha-256", async () => {
    await expect(environmentDeclarationDigest(declaration(base))).resolves.toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("declaration validators", () => {
  it("accepts domains and wildcards but never IP literals", () => {
    for (const ok of ["pypi.org", "*.npmjs.org", "registry.npmmirror.com"]) {
      expect(isValidEgressDomainPattern(ok)).toBe(true)
    }
    for (const bad of [
      "",
      "*.",
      "localhost",
      "10.0.0.1",
      "::1",
      "bad_host.com",
      "a..b.com",
      "evil.com.",
    ]) {
      expect(isValidEgressDomainPattern(bad)).toBe(false)
    }
  })

  it("normalizes egress domains to a sorted, lowercase, unique list", () => {
    const problems: DeclarationProblem[] = []
    expect(
      normalizeEgressDomains(
        ["PyPI.org", "*.npmjs.org", "pypi.org", "169.254.169.254"],
        "egress",
        problems
      )
    ).toEqual(["*.npmjs.org", "pypi.org"])
    expect(problems).toEqual([{ code: "declaration_egress_domain_invalid", field: "egress[3]" }])
    expect(normalizeEgressDomains("pypi.org", "egress", problems)).toEqual([])
  })

  it("lets later env entries win, null remove, and caps the count", () => {
    const problems: DeclarationProblem[] = []
    expect(
      normalizeEnv(
        [
          ["B", "1", "containerEnv.B"],
          ["A", "1", "containerEnv.A"],
          ["B", "2", "remoteEnv.B"],
          ["A", null, "remoteEnv.A"],
          ["NUL", "x\0y", "containerEnv.NUL"],
        ],
        problems
      )
    ).toEqual({ B: "2" })
    expect(problems).toEqual([
      { code: "declaration_env_invalid", field: "containerEnv.NUL", detail: { reason: "value" } },
    ])

    const many = Array.from(
      { length: 257 },
      (_, index) => [`V${index}`, "x", `e.V${index}`] as const
    )
    const tooMany: DeclarationProblem[] = []
    normalizeEnv(many, tooMany)
    expect(tooMany[0]).toMatchObject({
      code: "declaration_env_invalid",
      detail: { reason: "count" },
    })
  })

  it("bounds parallel commands and refuses nesting", () => {
    const problems: DeclarationProblem[] = []
    const seventeen = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`c${index}`, "true"])
    )
    expect(normalizeCommand(seventeen, "postStart", problems, identity)).toBeUndefined()
    expect(
      normalizeCommand({ outer: { inner: "x" } }, "postStart", problems, identity)
    ).toBeUndefined()
    expect(normalizeCommand(["", "x"], "postStart", problems, identity)).toBeUndefined()
    expect(normalizeCommand("   ", "postStart", problems, identity)).toBeUndefined()
    expect(problems.map((problem) => problem.field)).toEqual([
      "postStart",
      "postStart.outer",
      "postStart",
      "postStart",
    ])
  })

  it("labels ports and caps their count", () => {
    const problems: DeclarationProblem[] = []
    expect(normalizePorts([8080, "9000"], "ports", problems, new Map([[9000, "api"]]))).toEqual([
      { port: 8080 },
      { port: 9000, label: "api" },
    ])
    expect(
      normalizePorts(
        Array.from({ length: 65 }, (_, i) => i + 1),
        "ports",
        problems
      )
    ).toEqual([])
    expect(problems[0]).toMatchObject({
      code: "declaration_port_invalid",
      detail: { reason: "count" },
    })
  })

  it("accepts user names and uids, refuses groups and out-of-range uids", () => {
    const problems: DeclarationProblem[] = []
    expect(normalizeUser("vscode", "remoteUser", "u", problems)).toEqual({
      name: "vscode",
      from: "remoteUser",
    })
    expect(normalizeUser(0, "containerUser", "u", problems)).toEqual({
      uid: 0,
      from: "containerUser",
    })
    expect(normalizeUser(undefined, "remoteUser", "u", problems)).toBeUndefined()
    expect(normalizeUser("app:staff", "remoteUser", "u", problems)).toBeUndefined()
    expect(normalizeUser("4294967295", "remoteUser", "u", problems)).toBeUndefined()
    expect(normalizeUser("Root", "remoteUser", "u", problems)).toBeUndefined()
    expect(problems).toHaveLength(3)
  })
})
