import { configMenuRows } from "./config-menu"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

const base: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

describe("configMenuRows", () => {
  it("reflects the current settings", () => {
    const cfg: ResolvedConfig = {
      ...base,
      provider: "openai",
      model: "gpt-x",
      permissionMode: "plan",
      providers: { openai: { apiKey: "k" } },
    }
    const rows = configMenuRows(cfg)
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r.value]))
    expect(byAction.provider).toBe("openai")
    expect(byAction.model).toBe("gpt-x")
    expect(byAction.mode).toBe("plan")
    expect(byAction.auth).toBe("api key")
    expect(byAction.cwd).toBe("/work")
  })

  it("falls back to 'default' when no model is set", () => {
    const rows = configMenuRows(base)
    expect(rows.find((r) => r.action === "model")?.value).toBe("default")
  })
})
