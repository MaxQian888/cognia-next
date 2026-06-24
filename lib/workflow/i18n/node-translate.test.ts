import { pluginNodeMessageKey, tNode, tNodeField } from "./node-translate"

describe("tNode", () => {
  it("returns the translation when the key resolves", () => {
    const t = Object.assign((key: string) => `translated:${key}`, { has: (_k: string) => true })
    expect(tNode(t, "trigger.cron.label", "On schedule")).toBe("translated:trigger.cron.label")
  })

  it("returns the fallback when t.has reports the key is missing", () => {
    const t = Object.assign(
      (key: string) => {
        throw new Error(`should not be called for missing key: ${key}`)
      },
      { has: (_k: string) => false }
    )
    expect(tNode(t, "plugin.example.label", "My Plugin Node")).toBe("My Plugin Node")
  })

  it("falls back when t throws and has() is unavailable", () => {
    const t = (_key: string): string => {
      throw new Error("MISSING_MESSAGE")
    }
    expect(tNode(t as never, "trigger.cron.label", "On schedule")).toBe("On schedule")
  })

  it("returns the value when has() is unavailable and t() succeeds", () => {
    const t = (key: string) => `ok:${key}`
    expect(tNode(t as never, "trigger.cron.label", "On schedule")).toBe("ok:trigger.cron.label")
  })
})

describe("pluginNodeMessageKey", () => {
  it("builds the convention key for a flat-prefixed plugin node", () => {
    expect(pluginNodeMessageKey("git", "git.action.status", "label")).toBe(
      "plugin.git.workflow.nodes.action.status.label"
    )
  })

  it("restores the raw trigger. kind for a plugin trigger", () => {
    expect(pluginNodeMessageKey("git", "trigger.git.poll", "description")).toBe(
      "plugin.git.workflow.nodes.trigger.poll.description"
    )
  })
})

describe("tNodeField", () => {
  it("resolves a built-in node under the workflows.nodes namespace", () => {
    const t = Object.assign((key: string) => `translated:${key}`, { has: (_k: string) => true })
    expect(tNodeField(t, { kind: "trigger.cron", field: "label", fallback: "On schedule" })).toBe(
      "translated:workflows.nodes.trigger.cron.label"
    )
  })

  it("resolves a plugin node under its plugin.<id> namespace", () => {
    const t = Object.assign((key: string) => `translated:${key}`, { has: (_k: string) => true })
    expect(
      tNodeField(t, {
        kind: "git.action.status",
        pluginId: "git",
        field: "label",
        fallback: "Git status",
      })
    ).toBe("translated:plugin.git.workflow.nodes.action.status.label")
  })

  it("falls back to the author string when the plugin key is unregistered", () => {
    const t = Object.assign((_key: string) => "", { has: (_k: string) => false })
    expect(
      tNodeField(t, {
        kind: "git.action.status",
        pluginId: "git",
        field: "description",
        fallback: "Run git status",
      })
    ).toBe("Run git status")
  })
})
