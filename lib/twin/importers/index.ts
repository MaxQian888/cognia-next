/**
 * Public surface of the twin importers. Each importer turns a raw input
 * (mbox text, eml text, ChatGPT export JSON, Slack export JSON, git repo
 * path, …) into the `RawSource[]` shape the ingest pipeline consumes via
 * `parseSource` — or, more commonly, the uploader fans the output out
 * directly into multiple `twinSources` rows.
 *
 * The `isXShape()` detectors let the uploader auto-pick the right
 * importer when the user drops a JSON / text file whose origin isn't
 * obvious from the extension alone.
 */

// Email family
export { parseMbox, detectMbox } from "./email/mbox"
export type { MboxImportOptions } from "./email/mbox"
export { parseEml } from "./email/eml"
export type { EmlImportOptions } from "./email/eml"

// Code-repo family
export { parseGitRepo } from "./code-repo/git-repo"
export type { GitRepoImportOptions, CommitRecord } from "./code-repo/git-repo"

// Chat-export family — shared helpers
export {
  blocksToMarkdown,
  collectSpeakers,
  conversationToRawSource,
  timestampRange,
} from "./chat-export/types"
export type { ChatImporterOptions, ChatMessageBlock } from "./chat-export/types"

// Chat-export family — per-platform
export { parseChatgptExport, isChatgptExportShape } from "./chat-export/chatgpt"
export { parseClaudeExport, isClaudeExportShape } from "./chat-export/claude"
export { parseGeminiExport, isGeminiExportShape } from "./chat-export/gemini"
export { parseSlackExport } from "./chat-export/slack"
export type { SlackImportOptions } from "./chat-export/slack"
export { parseLarkExport, isLarkExportShape } from "./chat-export/lark"
export {
  parseDingtalkExport,
  isDingtalkTextShape,
  isDingtalkJsonShape,
} from "./chat-export/dingtalk"
export { parseWechatExport, isWechatExportShape } from "./chat-export/wechat"
