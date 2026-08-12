import { PassThrough } from "node:stream"

import fs from "node:fs"

import { createWorkerWorkspaceClient, resolveWorkerWorkspaceHelper } from "./workspace-client"

describe("createWorkerWorkspaceClient", () => {
  it("invokes the Task Workspace helper with stable refs and parses JSON", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new PassThrough(), { stdout, stderr, stdin })
    const spawn = jest.fn(() => process as never)
    const client = createWorkerWorkspaceClient({
      dataDir: "/worker-data",
      helperPath: "/bin/cognia-task-workspace-worker",
      spawn,
    })

    const pending = client.bind("repository:project-1:repo-1", "/work/repo")
    stdout.write(
      `${JSON.stringify({
        bindingRef: "repository:project-1:repo-1",
        sourceRoot: "/work/repo",
        gitCommonDir: "/work/repo/.git",
        repositoryFingerprint: "sha256:test",
        createdAt: 1,
        updatedAt: 1,
      })}\n`
    )
    process.emit("close", 0)

    await expect(pending).resolves.toMatchObject({
      bindingRef: "repository:project-1:repo-1",
    })
    expect(spawn).toHaveBeenCalledWith(
      "/bin/cognia-task-workspace-worker",
      [
        "bind",
        "--data-dir",
        "/worker-data",
        "--repository-ref",
        "repository:project-1:repo-1",
        "--path",
        "/work/repo",
      ],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    )
  })

  it("surfaces helper failures without accepting partial stdout", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new PassThrough(), { stdout, stderr, stdin })
    const client = createWorkerWorkspaceClient({
      dataDir: "/worker-data",
      helperPath: "helper",
      spawn: () => process as never,
    })
    const pending = client.resolve("repository:project-1:missing")
    stdout.write('{"bindingRef":"forged"}\n')
    stderr.write("workspace source is not bound")
    process.emit("close", 1)

    await expect(pending).rejects.toThrow("workspace source is not bound")
  })

  it("resolves an installed helper beside the bundled module before the Node executable", () => {
    const exists = jest
      .spyOn(fs, "existsSync")
      .mockImplementation((candidate) =>
        String(candidate).endsWith("/cli/dist/cognia-task-workspace-worker")
      )

    expect(
      resolveWorkerWorkspaceHelper(
        {},
        "file:///opt/cognia/cli/dist/chunks/workspace-client.mjs",
        "/usr/local/bin/node"
      )
    ).toBe("/opt/cognia/cli/dist/cognia-task-workspace-worker")

    exists.mockRestore()
  })
})
