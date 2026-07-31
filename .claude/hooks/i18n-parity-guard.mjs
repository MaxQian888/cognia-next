// PostToolUse hook: after editing any i18n message source, regenerate the big
// artifacts from the split sources and run the i18n gates. Exit 2 feeds the
// failure output back to Claude so drift is fixed immediately instead of
// surfacing at commit time.
//
// Source of truth is the per-namespace split files under
// `i18n/messages/{en,zh-CN}/`; `i18n/messages/{en,zh-CN}.json` are generated
// artifacts. The matcher therefore covers BOTH the split sources (any depth)
// and the generated big files. `i18n:build` rebuilds the big files from the
// split sources so the gates run against an up-to-date artifact.
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const input = JSON.parse(readFileSync(0, "utf8"))
const filePath = String(input.tool_input?.file_path ?? "").replace(/\\/g, "/")

if (!/(^|\/)i18n\/messages\/.+\.json$/.test(filePath)) process.exit(0)

const result = spawnSync("pnpm i18n:build && pnpm lint:i18n && pnpm i18n:sort:check", {
  shell: true,
  encoding: "utf8",
})

if (result.status !== 0) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-3000)
  process.stderr.write(
    `i18n gate failed after editing ${filePath}:\n${output}\n` +
      "Edit the split sources under i18n/messages/{en,zh-CN}/ (not the generated " +
      "big files), then `pnpm i18n:build` regenerates them. Keep key parity " +
      "between en and zh-CN (use `pnpm lint:i18n:baseline` only for intentional " +
      "baseline changes).\n"
  )
  process.exit(2)
}
