import type { WorkerWorkspaceClient } from "../worker/workspace-client"
import type { OutputSink } from "./output"
import { parseArgv } from "./args"
import { workerCommand } from "./worker-command"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (value) => stdout.push(value),
    error: (value) => stderr.push(value),
    json: (value) => stdout.push(`${JSON.stringify(value)}\n`),
  }
  return { out, stdout, stderr }
}

function client(): jest.Mocked<WorkerWorkspaceClient> {
  return {
    bind: jest.fn(),
    list: jest.fn(),
    remove: jest.fn(),
    resolve: jest.fn(),
    begin: jest.fn(),
  }
}

describe("workerCommand", () => {
  it("binds a repository through the Task Workspace authority", async () => {
    const output = sink()
    const workspace = client()
    workspace.bind.mockResolvedValue({
      bindingRef: "repository:project-1:repo-1",
      sourceRoot: "/work/repo",
      gitCommonDir: "/work/repo/.git",
      repositoryFingerprint: "sha256:test",
      createdAt: 1,
      updatedAt: 1,
    })

    const code = await workerCommand(
      parseArgv([
        "worker",
        "bind",
        "--repository-ref",
        "repository:project-1:repo-1",
        "--path",
        "/work/repo",
        "--json",
      ]),
      { out: output.out, workspace }
    )

    expect(code).toBe(0)
    expect(workspace.bind).toHaveBeenCalledWith("repository:project-1:repo-1", "/work/repo")
    expect(output.stdout.join("")).toContain("repository:project-1:repo-1")
  })

  it("lists and removes bindings without accepting remote paths", async () => {
    const output = sink()
    const workspace = client()
    workspace.list.mockResolvedValue([])
    workspace.remove.mockResolvedValue({ removed: true })

    await workerCommand(parseArgv(["worker", "list", "--json"]), {
      out: output.out,
      workspace,
    })
    await workerCommand(
      parseArgv(["worker", "remove", "--repository-ref", "repository:project-1:repo-1", "--json"]),
      { out: output.out, workspace }
    )

    expect(workspace.list).toHaveBeenCalled()
    expect(workspace.remove).toHaveBeenCalledWith("repository:project-1:repo-1")
  })

  it("connects with the paired worker identity and existing Task Workspace client", async () => {
    const workspace = client()
    const connect = jest.fn().mockResolvedValue(undefined)
    const runtimeConfig = { providers: {} } as never

    await expect(
      workerCommand(parseArgv(["worker", "connect", "--config", "/secure/worker.json"]), {
        workspace,
        connect,
        loadConfig: () => runtimeConfig,
        env: { COGNIA_HOME: "/worker-home" },
      })
    ).resolves.toBe(0)

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceConfigPath: "/secure/worker.json",
        runtimeConfig,
        home: "/worker-home",
        workspace,
        maxActiveTurns: 1,
      })
    )
  })

  it("enrolls a least-privilege worker identity into an owner-only config file", async () => {
    const output = sink()
    const enroll = jest.fn().mockResolvedValue({ deviceId: "worker-a" })

    await expect(
      workerCommand(
        parseArgv([
          "worker",
          "enroll",
          "--server-url",
          "https://brain.example",
          "--tenant-id",
          "tenant-a",
          "--enrollment",
          "one-time",
          "--config",
          "/secure/worker.json",
          "--json",
        ]),
        { workspace: client(), enroll, out: output.out }
      )
    ).resolves.toBe(0)

    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://brain.example",
        tenantId: "tenant-a",
        enrollment: "one-time",
        deviceConfigPath: "/secure/worker.json",
      })
    )
    expect(output.stdout.join("")).toContain('"deviceId":"worker-a"')
  })
})
