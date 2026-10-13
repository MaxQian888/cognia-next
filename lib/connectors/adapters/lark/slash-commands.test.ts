import {
  LARK_SLASH_COMMANDS_PATH,
  larkSlashCommandManifest,
  syncLarkSlashCommands,
  type LarkSlashRequest,
} from "./slash-commands"
import { LarkApiError } from "./auth-retry"
import { CONTROL_COMMAND_SPECS } from "@/lib/connectors/commands/registry"
import { parseControlCommand } from "@/lib/connectors/commands/parse"

const missingScope = () =>
  new LarkApiError({ status: 400, headers: {}, code: 99991672, message: "no scope" })

describe("larkSlashCommandManifest", () => {
  it("offers every control command as a word the dispatcher answers", () => {
    const manifest = larkSlashCommandManifest()
    expect(manifest.map((entry) => entry.command)).toEqual(
      CONTROL_COMMAND_SPECS.map((spec) => spec.name)
    )
    for (const entry of manifest) {
      expect(entry.command).toMatch(/^[a-z]+$/)
      // Feishu posts the chosen command back as `/<command>`.
      const parsed = parseControlCommand(`/${entry.command}`)
      expect(parsed.kind).toBe("known")
      expect(entry.description.default_value).toBe(entry.description.i18n.zh_cn)
      expect(entry.description.i18n.en_us).not.toBe("")
      expect(entry.description.icon.icon_key).toMatch(/_outlined$/)
    }
  })

  it("stays within Feishu's 100 commands per app", () => {
    expect(larkSlashCommandManifest().length).toBeLessThanOrEqual(100)
  })
})

describe("syncLarkSlashCommands", () => {
  const manifest = larkSlashCommandManifest().filter((entry) =>
    ["help", "status", "new"].includes(entry.command)
  )
  const help = manifest[0]
  const status = manifest[1]

  it("creates what is missing, rewrites what drifted, and leaves the rest alone", async () => {
    const calls: Array<[string, string, unknown]> = []
    const request: LarkSlashRequest = async (method, path, body) => {
      calls.push([method, path, body])
      if (method === "GET") {
        return {
          code: 0,
          data: {
            items: [
              // Registered as wanted, icon beside the description as listed.
              {
                command_id: "c-help",
                command: "help",
                description: {
                  default_value: help.description.default_value,
                  i18n: help.description.i18n,
                },
                icon: help.description.icon,
              },
              {
                command_id: "c-status",
                command: "status",
                description: { default_value: "stale", i18n: { zh_cn: "stale", en_us: "stale" } },
                icon: status.description.icon,
              },
              // An operator's own command: never touched.
              { command_id: "c-own", command: "deploy", description: { default_value: "x" } },
            ],
          },
        }
      }
      return { code: 0, data: { command_id: "c-new" } }
    }

    const result = await syncLarkSlashCommands(request, manifest)

    expect(result).toEqual({
      created: ["new"],
      updated: ["status"],
      unchanged: ["help"],
      failed: [],
    })
    expect(calls).toEqual([
      ["GET", LARK_SLASH_COMMANDS_PATH, undefined],
      ["PATCH", `${LARK_SLASH_COMMANDS_PATH}/c-status`, { description: status.description }],
      ["POST", LARK_SLASH_COMMANDS_PATH, manifest[2]],
    ])
  })

  it("names the read scope when the list cannot be read", async () => {
    const request: LarkSlashRequest = async () => {
      throw missingScope()
    }
    await expect(syncLarkSlashCommands(request, manifest)).rejects.toThrow(
      "application:app_slash_command:read"
    )
  })

  it("stops at a missing write scope instead of failing every command", async () => {
    const posts: string[] = []
    const request: LarkSlashRequest = async (method, _path, body) => {
      if (method === "GET") return { code: 0, data: { items: [] } }
      posts.push((body as { command: string }).command)
      throw missingScope()
    }

    const result = await syncLarkSlashCommands(request, manifest)

    expect(posts).toEqual(["help"])
    expect(result.created).toEqual([])
    expect(result.failed).toEqual([
      { command: "help", reason: expect.stringContaining("application:app_slash_command:write") },
    ])
  })

  it("reports one refused command and carries on with the rest", async () => {
    const request: LarkSlashRequest = async (method, _path, body) => {
      if (method === "GET") return { code: 0, data: { items: [] } }
      if ((body as { command: string }).command === "status") {
        throw new LarkApiError({
          status: 200,
          headers: {},
          code: 40000000,
          message: "command already exists",
        })
      }
      return { code: 0, data: { command_id: "id" } }
    }

    const result = await syncLarkSlashCommands(request, manifest)

    expect(result.created).toEqual(["help", "new"])
    expect(result.failed).toEqual([
      { command: "status", reason: expect.stringContaining("already exists") },
    ])
  })
})
