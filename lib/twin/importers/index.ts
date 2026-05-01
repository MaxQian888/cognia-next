/**
 * Public surface of the twin importers. Each importer turns a raw input
 * (mbox text, eml text, git repo path, …) into the `RawSource[]` shape the
 * ingest pipeline consumes via `parseSource`.
 */

export { parseMbox, detectMbox } from "./email/mbox"
export type { MboxImportOptions } from "./email/mbox"

export { parseEml } from "./email/eml"
export type { EmlImportOptions } from "./email/eml"

export { parseGitRepo } from "./code-repo/git-repo"
export type { GitRepoImportOptions, CommitRecord } from "./code-repo/git-repo"

export { parseSlackExport } from "./chat-export/slack"
export type { SlackImportOptions } from "./chat-export/slack"
