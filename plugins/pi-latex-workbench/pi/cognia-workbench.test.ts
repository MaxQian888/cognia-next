import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import cogniaWorkbench, {
  ADAPTER_ENTRY,
  createCogniaWorkbenchExtension,
  type WorkbenchAdapterModule,
} from "./cognia-workbench"

const piDir = __dirname
const WS = resolve("/work/ws")

describe("cognia-workbench Pi extension entry", () => {
  it("binds LATEXWB_* before the adapter loads, then registers on the given Pi API", async () => {
    const env: Record<string, string | undefined> = {
      COGNIA_PIPKG_LATEXWB_PROJECT: "demo",
      COGNIA_PIPKG_LATEXWB_WORKSPACE: "local",
      COGNIA_PIPKG_STATE_DIR: ".latexwb",
      COGNIA_PIPKG_WORKSPACE_DIR: WS,
    }
    const seenAtLoad: Array<string | undefined> = []
    const register = jest.fn()
    const pi = { registerTool: jest.fn() }
    const factory = createCogniaWorkbenchExtension({
      env,
      loadAdapter: async () => {
        // `WorkbenchSession.fromEnv` reads the binding during registration, so
        // it must already be in place when the module is loaded.
        seenAtLoad.push(env.LATEXWB_PROJECT, env.LATEXWB_STATE)
        return { registerWorkbenchExtension: register } satisfies WorkbenchAdapterModule
      },
    })

    await factory(pi)

    expect(seenAtLoad).toEqual(["demo", resolve(WS, ".latexwb")])
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(pi)
  })

  it("reports the computed binding to an observer", async () => {
    const onBinding = jest.fn()
    await createCogniaWorkbenchExtension({
      env: { COGNIA_PIPKG_LATEXWB_PROJECT: "" },
      loadAdapter: async () => ({ registerWorkbenchExtension: jest.fn() }),
      onBinding,
    })({})
    expect(onBinding).toHaveBeenCalledWith({
      assignments: {},
      skipped: [{ target: "LATEXWB_PROJECT", reason: "empty" }],
    })
  })

  it("fails loudly, without loading the adapter, when the state dir escapes the workspace", async () => {
    const loadAdapter = jest.fn()
    await expect(
      createCogniaWorkbenchExtension({
        env: { COGNIA_PIPKG_STATE_DIR: "../x", COGNIA_PIPKG_WORKSPACE_DIR: WS },
        loadAdapter,
      })({})
    ).rejects.toThrow(/inside the workspace/)
    expect(loadAdapter).not.toHaveBeenCalled()
  })

  it("propagates an adapter registration failure", async () => {
    await expect(
      createCogniaWorkbenchExtension({
        env: {},
        loadAdapter: async () => ({
          registerWorkbenchExtension: () => {
            throw new Error("boom")
          },
        }),
      })({})
    ).rejects.toThrow("boom")
  })

  it("default-exports a one-argument async factory, the shape Pi's loader awaits", () => {
    expect(typeof cogniaWorkbench).toBe("function")
    expect(cogniaWorkbench.length).toBe(1)
  })

  it("points at the vendored upstream adapter, which exports the registration it calls", () => {
    const entry = join(piDir, ADAPTER_ENTRY)
    expect(existsSync(entry)).toBe(true)
    expect(readFileSync(entry, "utf8")).toMatch(
      /export function registerWorkbenchExtension\(\s*pi: ExtensionAPI,/
    )
  })
})

// Pi loads this file through jiti; Node's own type stripping is the stricter
// of the two (erasable syntax only, explicit `.ts` specifiers), so prove the
// entry and its binding module run natively, outside Jest's transform.
const nodeStripsTypes = Boolean((process.features as { typescript?: unknown }).typescript)
const describeNative = nodeStripsTypes ? describe : describe.skip

describeNative("cognia-workbench under native Node type stripping", () => {
  it("imports, binds the environment and registers through an injected adapter", () => {
    const entryUrl = pathToFileURL(join(piDir, "cognia-workbench.ts")).href
    const script = `
      const { createCogniaWorkbenchExtension, ADAPTER_ENTRY } = await import(${JSON.stringify(entryUrl)})
      const env = {
        COGNIA_PIPKG_LATEXWB_PROJECT: "demo",
        COGNIA_PIPKG_STATE_DIR: ".latexwb",
        COGNIA_PIPKG_WORKSPACE_DIR: ${JSON.stringify(WS)},
      }
      const registered = []
      await createCogniaWorkbenchExtension({
        env,
        loadAdapter: async () => ({ registerWorkbenchExtension: (pi) => registered.push(pi.id) }),
      })({ id: "pi-api" })
      console.log(JSON.stringify({ registered, project: env.LATEXWB_PROJECT, state: env.LATEXWB_STATE, ADAPTER_ENTRY }))
    `
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    })
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      registered: ["pi-api"],
      project: "demo",
      state: resolve(WS, ".latexwb"),
      ADAPTER_ENTRY,
    })
  })
})
