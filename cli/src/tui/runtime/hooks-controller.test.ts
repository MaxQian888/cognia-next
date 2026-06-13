import { buildHooksDocument, hooksList } from "./hooks-controller"
import type { HooksConfig } from "../../hooks/types"
import type { TuiAction } from "../state/types"

describe("buildHooksDocument", () => {
  it("renders an empty config as a no-hooks guide", () => {
    const body = buildHooksDocument({})
    expect(body).toContain("No hooks are configured")
    expect(body).toContain("~/.cognia/config.json")
  })

  it("groups configured hooks by event with matcher + command", () => {
    const config: HooksConfig = {
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "./guard.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "notify.sh", timeout: 5 }] }],
    }
    const body = buildHooksDocument(config)
    expect(body).toContain("## PreToolUse")
    expect(body).toContain("matcher `Edit|Write`")
    expect(body).toContain("`./guard.sh`")
    expect(body).toContain("## Stop")
    expect(body).toContain("matches all")
    expect(body).toContain("(timeout 5s)")
  })

  it("marks webhook + unknown handlers inert", () => {
    const config: HooksConfig = {
      Notification: [
        {
          hooks: [
            { type: "webhook", url: "https://x.test/h" },
            { type: "mcp", server: "s" } as never,
          ],
        },
      ],
    }
    const body = buildHooksDocument(config)
    expect(body).toContain("webhook → https://x.test/h (inert")
    expect(body).toContain("mcp handler (inert)")
  })
})

describe("hooksList", () => {
  function harness(files: Record<string, string>) {
    const actions: TuiAction[] = []
    const readFile = (p: string): string | null => {
      const hit = Object.entries(files).find(([k]) => p.endsWith(k))
      return hit ? hit[1] : null
    }
    return {
      actions,
      deps: {
        dispatch: (a: TuiAction) => void actions.push(a),
        home: "/home/.cognia",
        osHome: "/home",
        readFile,
      },
    }
  }

  it("opens a document overlay titled with the group count", () => {
    const { actions, deps } = harness({
      "config.json": JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "g.sh" }] }] },
      }),
      "settings.json": JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "s.sh" }] }] },
      }),
    })
    hooksList(deps)
    expect(actions).toHaveLength(1)
    const action = actions[0]
    expect(action.type).toBe("OVERLAY_OPEN")
    if (action.type === "OVERLAY_OPEN" && action.overlay.kind === "document") {
      expect(action.overlay.title).toBe("Hooks (2)")
      expect(action.overlay.body).toContain("## PreToolUse")
      expect(action.overlay.body).toContain("## Stop")
    } else {
      throw new Error("expected a document overlay")
    }
  })

  it("opens a no-hooks document when nothing is configured", () => {
    const { actions, deps } = harness({})
    hooksList(deps)
    const action = actions[0]
    if (action.type === "OVERLAY_OPEN" && action.overlay.kind === "document") {
      expect(action.overlay.title).toBe("Hooks")
      expect(action.overlay.body).toContain("No hooks are configured")
    } else {
      throw new Error("expected a document overlay")
    }
  })
})
