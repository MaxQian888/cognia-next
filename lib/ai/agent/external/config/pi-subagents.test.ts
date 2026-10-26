import {
  resolvePiSubagents,
  piSubagentModelBindings,
  piSubagentSupport,
  piModelBinding,
} from "./pi-subagents"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const config = {
  protocol: "pi-rpc",
  transport: "stdio",
  process: { command: "pi", cwd: "/repo" },
} as ExternalAgentConfig
const root = "/home/pi"
function fixture(name = "pi-subagents", version = "0.80.0") {
  const files: Record<string, string> = {
    [`${root}/settings.json`]: JSON.stringify({ packages: [`npm:${name}@${version}`] }),
    [`${root}/npm/node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version,
      pi: { extensions: ["index.js"] },
    }),
    [`${root}/npm/node_modules/${name}/index.js`]: "export default function extension() {}",
    [`${root}/agents/reviewer.md`]:
      "---\nmodel: cognia/review\ndescription: Reviewer\n---\nReview carefully.",
    "/repo/.pi/agents/worker.md": "---\ndescription: Worker\n---\nImplement carefully.",
  }
  return {
    files,
    deps: {
      agentDir: async () => root,
      read: async (path: string) => files[path] ?? null,
      list: async (path: string) =>
        Object.keys(files).filter(
          (file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")
        ),
    },
  }
}

it.each([
  ["pi-subagents", "0.80.0", "nico"],
  ["@gotgenes/pi-subagents", "19.2.2", "gotgenes"],
])("detects an installed enabled %s package", async (name, version, family) => {
  const { deps } = fixture(name, version)
  const resolved = await resolvePiSubagents(config, deps)
  expect(piSubagentSupport(resolved)?.family).toBe(family)
  expect(piSubagentSupport(resolved)?.agents.worker.model).toBeUndefined()
  expect(piSubagentModelBindings(resolved, { providerId: "deepseek", modelId: "main" })).toEqual({
    "pi.agent.reviewer": { providerId: "deepseek", modelId: "review" },
  })
})

it.each(["missing", "disabled", "uninstalled", "unsupported", "filtered", "broken"])(
  "does not enable capability for a %s package",
  async (scenario) => {
    const { files, deps } = fixture()
    if (scenario === "missing") files[`${root}/settings.json`] = "{}"
    if (scenario === "disabled")
      files[`${root}/settings.json`] = JSON.stringify({
        packages: [{ source: "npm:pi-subagents@0.80.0", autoload: false }],
      })
    if (scenario === "uninstalled")
      delete files[`${root}/npm/node_modules/pi-subagents/package.json`]
    if (scenario === "broken") delete files[`${root}/npm/node_modules/pi-subagents/index.js`]
    if (scenario === "unsupported")
      files[`${root}/npm/node_modules/pi-subagents/package.json`] = JSON.stringify({
        name: "pi-subagents",
        version: "9.0.0",
      })
    if (scenario === "filtered")
      files[`${root}/settings.json`] = JSON.stringify({
        packages: [{ source: "npm:pi-subagents@0.80.0", extensions: [] }],
      })
    expect(piSubagentSupport(await resolvePiSubagents(config, deps))).toBeUndefined()
  }
)

it("preserves Nico operator role overrides and its existing child default", async () => {
  const { files, deps } = fixture()
  files[`${root}/settings.json`] = JSON.stringify({
    packages: ["npm:pi-subagents@0.80.0"],
    subagents: {
      defaultModel: "cognia/native-default",
      agentOverrides: { reviewer: { model: "cognia/operator-review" } },
    },
  })
  const resolved = await resolvePiSubagents(config, deps)
  expect(piSubagentModelBindings(resolved, { providerId: "deepseek", modelId: "main" })).toEqual({
    "pi.default": { providerId: "deepseek", modelId: "native-default" },
    "pi.agent.reviewer": { providerId: "deepseek", modelId: "operator-review" },
  })
})

it("refreshes stale capability metadata instead of trusting it", async () => {
  const { deps } = fixture()
  const resolved = await resolvePiSubagents(config, deps)
  const next = await resolvePiSubagents(resolved, { ...deps, read: async () => null })
  expect(piSubagentSupport(next)).toBeUndefined()
})

it("preserves project model precedence and explicit inheritance", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/agents/reviewer.md"] = "---\nmodel: inherit\n---\nProject reviewer"
  const resolved = await resolvePiSubagents(config, deps)
  expect(piSubagentModelBindings(resolved, { providerId: "deepseek", modelId: "main" })).toEqual({
    "pi.agent.reviewer": { providerId: "deepseek", modelId: "main" },
  })
})

it("refuses invalid explicit models instead of treating them as omission", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/agents/worker.md"] = "---\nmodel: 123\n---\nWorker"
  await expect(resolvePiSubagents(config, deps)).rejects.toThrow(/model/)
})

it("does no filesystem work for another runtime", async () => {
  const deps = fixture().deps
  const read = jest.fn(deps.read)
  await resolvePiSubagents({ ...config, protocol: "acp" }, { ...deps, read })
  expect(read).not.toHaveBeenCalled()
})

it("rejects conflicting enabled executors", async () => {
  const nico = fixture()
  const gg = fixture("@gotgenes/pi-subagents", "19.2.2")
  Object.assign(nico.files, gg.files)
  nico.files[`${root}/settings.json`] = JSON.stringify({
    packages: ["npm:pi-subagents@0.80.0", "npm:@gotgenes/pi-subagents@19.2.2"],
  })
  await expect(resolvePiSubagents(config, nico.deps)).rejects.toThrow(/Multiple Pi/)
})
it("preserves project-level Nico model overrides over user choices", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/settings.json"] = JSON.stringify({
    subagents: {
      defaultModel: "cognia/project-default",
      agentOverrides: { reviewer: { model: "cognia/project-review" } },
    },
  })
  const resolved = await resolvePiSubagents(config, deps)
  expect(piSubagentModelBindings(resolved, { providerId: "p", modelId: "main" })).toEqual({
    "pi.default": { providerId: "p", modelId: "project-default" },
    "pi.agent.reviewer": { providerId: "p", modelId: "project-review" },
  })
})
it("requests recursive standard-directory discovery only for Nico", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/agents/nested/expert.md"] =
    "---\nname: expert\nmodel: cognia/expert\n---\nExpert"
  const list = jest.fn(async (dir: string, recursive?: boolean) =>
    Object.keys(files).filter(
      (file) =>
        file.startsWith(`${dir}/`) && (recursive || !file.slice(dir.length + 1).includes("/"))
    )
  )
  expect(
    piSubagentSupport(await resolvePiSubagents(config, { ...deps, list }))?.agents.expert.model
  ).toBe("cognia/expert")
  expect(list).toHaveBeenCalledWith("/repo/.pi/agents", true)
})
it.each(["", "bad:high", "bad*", "bad model"])(
  "refuses unsupported explicit reference %s",
  (model) => {
    expect(() => piModelBinding(model, { providerId: "p", modelId: "main" })).toThrow(/reference/)
  }
)
it("refuses alternate Nico discovery rather than silently losing its explicit models", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/settings.json"] = JSON.stringify({
    subagents: { agentScanDirs: ["custom-agents"] },
  })
  await expect(resolvePiSubagents(config, deps)).rejects.toThrow(/standard agent directories/)
})

it("finds nearest ancestor project agents and ignores Nico chain definitions", async () => {
  const { files, deps } = fixture()
  files["/repo/.pi/agents/review.chain.md"] = "---\nchain: []\n---\nChain"
  const detected = await resolvePiSubagents(
    { ...config, process: { command: "pi", cwd: "/repo/src/nested" } },
    deps
  )
  expect(piSubagentSupport(detected)?.agents.worker).toBeDefined()
  expect(Object.keys(piSubagentSupport(detected)!.agents)).not.toContain("review.chain")
})
