/**
 * Cross-importer guard: every JSON-based chat-export importer must surface a
 * clear, platform-labelled error on malformed input (via `parseChatExportJson`)
 * rather than leaking a bare `SyntaxError`. DingTalk is intentionally excluded —
 * it falls back to bracket-text parsing on JSON failure by design.
 */

import { parseSlackExport } from "./slack"
import { parseLarkExport } from "./lark"
import { parseWechatExport } from "./wechat"
import { parseChatgptExport } from "./chatgpt"
import { parseClaudeExport } from "./claude"
import { parseGeminiExport } from "./gemini"

const opts = { twinId: "t1" }

describe("chat-export importers — malformed JSON", () => {
  it.each([
    ["Slack", () => parseSlackExport("not json", opts)],
    ["Lark", () => parseLarkExport("not json", opts)],
    ["WeChat", () => parseWechatExport("not json", opts)],
    ["ChatGPT", () => parseChatgptExport("not json", opts)],
    ["Claude", () => parseClaudeExport("not json", opts)],
    ["Gemini", () => parseGeminiExport("not json", opts)],
  ])("%s throws a platform-labelled malformed-JSON error", (platform, run) => {
    expect(run).toThrow(new RegExp(`${platform} import: malformed JSON`))
  })
})
