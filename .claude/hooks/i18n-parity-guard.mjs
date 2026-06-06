// PostToolUse hook: after editing i18n/messages/*.json, run the i18n gates.
// Exit 2 feeds the failure output back to Claude so drift is fixed immediately
// instead of surfacing at commit time.
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const input = JSON.parse(readFileSync(0, "utf8"))
const filePath = String(input.tool_input?.file_path ?? "").replace(/\\/g, "/")

if (!/(^|\/)i18n\/messages\/[^/]+\.json$/.test(filePath)) process.exit(0)

const result = spawnSync("pnpm lint:i18n && pnpm i18n:sort:check", {
  shell: true,
  encoding: "utf8",
})

if (result.status !== 0) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-3000)
  process.stderr.write(
    `i18n gate failed after editing ${filePath}:\n${output}\n` +
      "Fix key parity between i18n/messages/en.json and zh-CN.json " +
      "(or run `pnpm lint:i18n:baseline` only for intentional baseline changes, " +
      "and `pnpm i18n:sort` for ordering).\n"
  )
  process.exit(2)
}
