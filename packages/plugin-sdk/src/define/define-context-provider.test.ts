import { defineContextProvider } from "./define-context-provider"
import type {
  PluginContextProvider,
  PluginContextProviderDef,
} from "@/types/plugin/plugin-context-provider"

describe("defineContextProvider", () => {
  it("returns the runtime provider unchanged (identity pass-through)", () => {
    const p: PluginContextProvider = { id: "ctx", provide: () => "x" }
    expect(defineContextProvider(p)).toBe(p)
  })

  it("returns the declarative manifest provider entry unchanged", () => {
    const def: PluginContextProviderDef = {
      id: "repo",
      label: "Repository Context",
      entry: "src/context/repo.ts",
      export: "createRepoContextProvider",
    }

    expect(defineContextProvider(def)).toBe(def)
  })
})
