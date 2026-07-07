import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import type { StrixFinding, StrixRun } from "../types"
import { counterId, createMockTerminal, immediateSleep, type CommandResolver } from "./mock-shell"
import { runScan } from "./strix-runner"

function fakeDexie() {
  const runs: StrixRun[] = []
  const findings: StrixFinding[] = []
  const api = {
    table: (name: string) => {
      if (name === "runs") {
        return {
          put: async (r: StrixRun) => {
            const i = runs.findIndex((x) => x.runId === r.runId)
            if (i >= 0) runs[i] = r
            else runs.push(r)
          },
        }
      }
      return {
        bulkPut: async (rs: StrixFinding[]) => {
          findings.push(...rs)
        },
      }
    },
  } as unknown as PluginDexieAPI
  return { api, runs, findings }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")

function deps(terminal: ReturnType<typeof createMockTerminal>["terminal"], dexie: PluginDexieAPI) {
  return {
    terminal,
    dexie,
    now: () => 100,
    randomId: counterId(),
    sleep: immediateSleep,
    pollMs: 0,
  }
}

describe("runScan", () => {
  it("runs a scan, streams output, parses findings, and persists (vulns found)", async () => {
    const vulns = [
      { id: "vuln-0001", title: "SQLi", severity: "high", cvss: 8.1 },
      { id: "vuln-0002", title: "XSS", severity: "critical" },
    ]
    const resolver: CommandResolver = (inner) => {
      if (inner.startsWith("mkdir")) return { exitCode: 0 }
      if (inner.startsWith("strix -n")) return { output: "scanning https://x", exitCode: 2 }
      if (inner.includes("vulnerabilities.json")) return { output: b64(vulns), exitCode: 0 }
      if (inner.includes("run.json")) return { output: b64({ status: "completed" }), exitCode: 0 }
      return { exitCode: 0 }
    }
    const { terminal } = createMockTerminal(resolver)
    const dexie = fakeDexie()
    const consoleChunks: string[] = []

    const run = await runScan(
      { target: "https://x" },
      { ...deps(terminal, dexie.api), onConsole: (t) => consoleChunks.push(t) }
    )

    expect(run.status).toBe("done")
    expect(run.exitCode).toBe(2)
    expect(run.findingsCount).toBe(2)
    expect(consoleChunks.join("")).toContain("scanning https://x")
    expect(dexie.findings.map((f) => f.severity).sort()).toEqual(["critical", "high"])
    expect(dexie.runs.at(-1)?.status).toBe("done")
    expect(dexie.runs.at(-1)?.authorizedAt).toBe(100)
  })

  it("marks a clean scan done with zero findings when no report file exists", async () => {
    const { terminal } = createMockTerminal((inner) => {
      if (inner.startsWith("strix -n")) return { exitCode: 0 }
      if (inner.includes("vulnerabilities.json")) return { exitCode: 1 } // missing file
      if (inner.includes("run.json")) return { output: b64({ status: "completed" }), exitCode: 0 }
      return { exitCode: 0 }
    })
    const dexie = fakeDexie()
    const run = await runScan({ target: "x" }, deps(terminal, dexie.api))
    expect(run.status).toBe("done")
    expect(run.exitCode).toBe(0)
    expect(run.findingsCount).toBe(0)
    expect(dexie.findings).toHaveLength(0)
  })

  it("marks the run errored when strix exits 1", async () => {
    const { terminal } = createMockTerminal((inner) => {
      if (inner.startsWith("strix -n")) return { exitCode: 1 }
      return { exitCode: 1 }
    })
    const dexie = fakeDexie()
    const run = await runScan({ target: "x" }, deps(terminal, dexie.api))
    expect(run.status).toBe("error")
    expect(run.error).toBeTruthy()
  })

  it("errors when the scan directory can't be prepared", async () => {
    const { terminal } = createMockTerminal((inner) => {
      if (inner.startsWith("mkdir")) return { exitCode: 1 }
      return { exitCode: 0 }
    })
    const dexie = fakeDexie()
    const run = await runScan({ target: "x" }, deps(terminal, dexie.api))
    expect(run.status).toBe("error")
    expect(run.exitCode).toBe(1)
  })

  it("cancels when the signal is aborted", async () => {
    const { terminal, killed } = createMockTerminal(() => ({ exitCode: 0 }))
    const dexie = fakeDexie()
    const controller = new AbortController()
    controller.abort()
    const run = await runScan(
      { target: "x" },
      { ...deps(terminal, dexie.api), signal: controller.signal }
    )
    expect(run.status).toBe("cancelled")
    expect(killed).toContain("sess-1")
  })

  it("passes model/apiKey via env, not the command line", async () => {
    const { terminal, writes } = createMockTerminal((inner) => {
      if (inner.startsWith("strix -n")) return { exitCode: 0 }
      return { exitCode: 0 }
    })
    const dexie = fakeDexie()
    await runScan(
      { target: "x", model: "openai/gpt-5", apiKey: "secret" },
      deps(terminal, dexie.api)
    )
    const strixWrite = writes.find((w) => w.includes("strix -n"))
    expect(strixWrite).toBeDefined()
    expect(strixWrite).not.toContain("secret")
    expect(strixWrite).not.toContain("openai/gpt-5")
  })
})
