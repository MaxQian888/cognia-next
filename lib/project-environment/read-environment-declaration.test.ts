import { environmentDeclarationDigest } from "./environment-declaration"
import { readEnvironmentDeclaration } from "./read-environment-declaration"
import { parseWorkspaceConfig } from "./workspace-config"
import type { WorkspaceConfigVerdict } from "./workspace-config-trust"

const ROOT = "/repos/app"

function files(tree: Record<string, string>) {
  return jest.fn(async (_root: string, path: string) => {
    if (path in tree) return tree[path]!
    throw new Error(`canonicalize ${ROOT}/${path}: No such file or directory (os error 2)`)
  })
}

function configVerdict(
  config: unknown,
  kind: "approved" | "unapproved" = "approved"
): WorkspaceConfigVerdict {
  return { kind, digest: "d".repeat(64), config: parseWorkspaceConfig(JSON.stringify(config)) }
}

const ABSENT: WorkspaceConfigVerdict = { kind: "absent" }
const DEVCONTAINER = JSON.stringify({
  image: "python:3.12-slim",
  postCreateCommand: "pip install -e .",
})

describe("readEnvironmentDeclaration", () => {
  it("prefers an inline workspace.json block and reads no devcontainer", async () => {
    const readFile = files({ ".devcontainer/devcontainer.json": DEVCONTAINER })
    const verdict = await readEnvironmentDeclaration(
      {
        root: ROOT,
        restricted: false,
        workspaceConfig: configVerdict(
          { version: 1, environment: { image: "node:22" } },
          "unapproved"
        ),
      },
      { readFile }
    )
    expect(verdict).toMatchObject({
      kind: "declared",
      declaration: { file: "workspace-json", image: { repository: "library/node" } },
    })
    expect(readFile).not.toHaveBeenCalled()
    if (verdict.kind === "declared") {
      await expect(environmentDeclarationDigest(verdict.declaration)).resolves.toBe(verdict.digest)
    }
  })

  it("follows a devcontainer pointer and adds the block's egress domains", async () => {
    const readFile = files({ ".devcontainer/py/devcontainer.json": DEVCONTAINER })
    const verdict = await readEnvironmentDeclaration(
      {
        root: ROOT,
        restricted: false,
        workspaceConfig: configVerdict({
          version: 1,
          environment: {
            devcontainer: ".devcontainer/py/devcontainer.json",
            egressDomains: ["pypi.org"],
          },
        }),
      },
      { readFile }
    )
    expect(verdict).toMatchObject({
      kind: "declared",
      declaration: {
        file: "devcontainer",
        path: ".devcontainer/py/devcontainer.json",
        egressDomains: ["pypi.org"],
      },
    })
    expect(readFile).toHaveBeenCalledWith(
      ROOT,
      ".devcontainer/py/devcontainer.json",
      256 * 1024 + 1
    )
  })

  it("reports a pointer to a missing devcontainer instead of falling back", async () => {
    const verdict = await readEnvironmentDeclaration(
      {
        root: ROOT,
        restricted: false,
        workspaceConfig: configVerdict({
          version: 1,
          environment: { devcontainer: ".devcontainer.json" },
        }),
      },
      { readFile: files({ ".devcontainer/devcontainer.json": DEVCONTAINER }) }
    )
    expect(verdict).toMatchObject({
      kind: "invalid",
      path: ".cognia/workspace.json",
      problems: [{ code: "declaration_path_invalid", detail: { reason: "missing" } }],
    })
  })

  it("discovers devcontainer files in order when workspace.json declares nothing", async () => {
    const readFile = files({ ".devcontainer.json": DEVCONTAINER })
    const verdict = await readEnvironmentDeclaration(
      { root: ROOT, restricted: false, workspaceConfig: ABSENT },
      { readFile }
    )
    expect(verdict).toMatchObject({ kind: "declared", declaration: { path: ".devcontainer.json" } })
    expect(readFile.mock.calls.map((call) => call[1])).toEqual([
      ".devcontainer/devcontainer.json",
      ".devcontainer.json",
    ])
  })

  it("surfaces a broken environment block but not an unrelated workspace.json error", async () => {
    const readFile = files({ ".devcontainer/devcontainer.json": DEVCONTAINER })
    const environmentBroken = await readEnvironmentDeclaration(
      {
        root: ROOT,
        restricted: false,
        workspaceConfig: {
          kind: "invalid",
          message: "environment is invalid",
          field: "environment.image",
          problems: [{ code: "declaration_image_invalid", field: "environment.image" }],
        },
      },
      { readFile }
    )
    expect(environmentBroken).toMatchObject({ kind: "invalid", path: ".cognia/workspace.json" })

    const setupBroken = await readEnvironmentDeclaration(
      {
        root: ROOT,
        restricted: false,
        workspaceConfig: { kind: "invalid", message: "bad roots", field: "roots[0].path" },
      },
      { readFile }
    )
    expect(setupBroken).toMatchObject({ kind: "declared", declaration: { file: "devcontainer" } })
  })

  it("reports an invalid devcontainer with its problems and notices", async () => {
    const verdict = await readEnvironmentDeclaration(
      { root: ROOT, restricted: false, workspaceConfig: ABSENT },
      {
        readFile: files({
          ".devcontainer/devcontainer.json": JSON.stringify({
            name: "x",
            image: "node:22",
            privileged: true,
          }),
        }),
      }
    )
    expect(verdict).toEqual({
      kind: "invalid",
      path: ".devcontainer/devcontainer.json",
      problems: [{ code: "devcontainer_field_refused", field: "privileged" }],
      notices: [{ code: "declaration_field_ignored", field: "name" }],
    })
  })

  it("reads nothing in a restricted checkout or without a root", async () => {
    const readFile = files({ ".devcontainer/devcontainer.json": DEVCONTAINER })
    await expect(
      readEnvironmentDeclaration(
        { root: ROOT, restricted: true, workspaceConfig: ABSENT },
        { readFile }
      )
    ).resolves.toEqual({ kind: "restricted" })
    await expect(
      readEnvironmentDeclaration(
        { root: " ", restricted: false, workspaceConfig: ABSENT },
        { readFile }
      )
    ).resolves.toEqual({ kind: "absent" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("propagates read failures other than a missing file", async () => {
    const readFile = jest.fn(async () => {
      throw new Error("path escapes workspace: /etc (root /repos/app)")
    })
    await expect(
      readEnvironmentDeclaration(
        { root: ROOT, restricted: false, workspaceConfig: ABSENT },
        { readFile }
      )
    ).rejects.toThrow(/escapes workspace/)
  })
})
