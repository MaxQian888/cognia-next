import {
  __resetTeamWorkflowNodesForTesting,
  hasTeamWorkflowNodes,
  installTeamWorkflowNodes,
  loadTeamWorkflowNodes,
  type TeamWorkflowNodes,
} from "./team-runtime-port"

const nodes = { run: jest.fn() } as unknown as TeamWorkflowNodes

afterEach(() => __resetTeamWorkflowNodesForTesting())

describe("team workflow node port", () => {
  it("fails a team node with a non-retryable error until a host installs the runtime", async () => {
    expect(hasTeamWorkflowNodes()).toBe(false)
    await expect(loadTeamWorkflowNodes("action.team.run")).rejects.toMatchObject({
      message: expect.stringContaining("not installed on this host"),
      retryable: false,
    })
  })

  it("loads the installed implementations once and reuses them", async () => {
    const load = jest.fn(async () => nodes)
    installTeamWorkflowNodes(load)
    installTeamWorkflowNodes(load)
    expect(hasTeamWorkflowNodes()).toBe(true)
    expect(await loadTeamWorkflowNodes("action.team.run")).toBe(nodes)
    expect(await loadTeamWorkflowNodes("action.team.status")).toBe(nodes)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("retries a failed load instead of caching the failure", async () => {
    const load = jest
      .fn<Promise<TeamWorkflowNodes>, []>()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockResolvedValueOnce(nodes)
    installTeamWorkflowNodes(load)
    await expect(loadTeamWorkflowNodes("action.team.run")).rejects.toThrow("chunk load failed")
    expect(await loadTeamWorkflowNodes("action.team.run")).toBe(nodes)
  })
})

describe("dependency direction", () => {
  it("keeps the workflow engine free of Agent Team imports (ADR-0217)", () => {
    const fs = jest.requireActual<typeof import("node:fs")>("node:fs")
    const path = jest.requireActual<typeof import("node:path")>("node:path")
    const root = path.join(process.cwd(), "lib/workflow")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8")
          if (/["']@\/(lib\/ai\/agent\/team|stores\/agent\/agent-team-store)/.test(text)) {
            offenders.push(path.relative(process.cwd(), full))
          }
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
