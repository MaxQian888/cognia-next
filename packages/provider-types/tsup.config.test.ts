jest.mock("tsup", () => ({
  defineConfig: jest.fn((config: unknown) => config),
}))

import tsupConfig from "./tsup.config"

const resolveConfig = async () => {
  const config =
    typeof tsupConfig === "function"
      ? await tsupConfig({
          env: {},
        } as never)
      : await tsupConfig

  if (Array.isArray(config)) {
    throw new Error("Expected a single provider-types tsup config")
  }

  return config
}

describe("@cognia/provider-types tsup config", () => {
  it("builds every public source module for ESM, CJS, and declarations", async () => {
    const config = await resolveConfig()

    expect(config).toEqual(
      expect.objectContaining({
        entry: ["src/**/*.ts", "!src/**/*.test.ts"],
        format: ["esm", "cjs"],
        dts: true,
        sourcemap: true,
        clean: true,
        target: "es2017",
      })
    )
  })

  it("keeps only zod and internal provider workspaces external", async () => {
    const config = await resolveConfig()

    expect(config.external).toEqual([
      "zod",
      expect.objectContaining({
        source: "^@cognia\\/provider-",
      }),
    ])
  })
})
