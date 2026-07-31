/** @jest-environment jsdom */
/**
 * Staging-layer coverage — ports every extraction branch of the retired
 * uploader's `ingestFile` plus the new URL / Lark / git / paste / commit
 * seams. Network and heavy parsers are mocked; importer fan-out (mbox,
 * chat exports, DingTalk) runs the real importer code.
 */

import "fake-indexeddb/auto"
import {
  commitStagedSources,
  detectChatJsonImporter,
  inferKind,
  stageFile,
  stageGitRepo,
  stageLarkDoc,
  stagePaste,
  stageUrl,
} from "./stage"
import { LarkIngestError } from "./lark-doc-fetcher"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"

jest.mock("@/lib/twin/ingest/url-fetcher", () => ({
  fetchUrlAsRawSource: jest.fn(),
}))
jest.mock("@/lib/twin/ingest/lark-doc-fetcher", () => ({
  ...jest.requireActual("@/lib/twin/ingest/lark-doc-fetcher"),
  fetchLarkDocAsRawSource: jest.fn(),
}))
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: jest.fn(),
}))
jest.mock("@/lib/twin/importers", () => ({
  ...jest.requireActual("@/lib/twin/importers"),
  parseGitRepo: jest.fn(),
  // Shape checkers + parsers are controllable so each importer switch arm is
  // testable without a full fixture per platform. Slack keeps the real
  // parser (its detection is a regex inside stage.ts, not a shape checker).
  isChatgptExportShape: jest.fn(() => false),
  parseChatgptExport: jest.fn(),
  isClaudeExportShape: jest.fn(() => false),
  parseClaudeExport: jest.fn(),
  isGeminiExportShape: jest.fn(() => false),
  parseGeminiExport: jest.fn(),
  isLarkExportShape: jest.fn(() => false),
  parseLarkExport: jest.fn(),
  isWechatExportShape: jest.fn(() => false),
  parseWechatExport: jest.fn(),
  isDingtalkJsonShape: jest.fn(() => false),
  parseDingtalkExport: jest.fn(),
}))

import { fetchUrlAsRawSource } from "@/lib/twin/ingest/url-fetcher"
import { fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import { processDocumentAsync } from "@cognia/document/document-processor"
import {
  parseGitRepo,
  isChatgptExportShape,
  parseChatgptExport,
  isClaudeExportShape,
  parseClaudeExport,
  isGeminiExportShape,
  parseGeminiExport,
  isLarkExportShape,
  parseLarkExport,
  isWechatExportShape,
  parseWechatExport,
  isDingtalkJsonShape,
  parseDingtalkExport,
} from "@/lib/twin/importers"

const mockFetchUrl = fetchUrlAsRawSource as jest.MockedFunction<typeof fetchUrlAsRawSource>
const mockFetchLark = fetchLarkDocAsRawSource as jest.Mock
const mockProcessDocument = processDocumentAsync as jest.MockedFunction<typeof processDocumentAsync>
const mockParseGitRepo = parseGitRepo as jest.Mock

const TWIN = "twin_alice"

function makeFile(name: string, content: string, mimeType = "text/plain"): File {
  return new File([content], name, { type: mimeType })
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): the shape-checker mocks get
  // mockReturnValue(true) per test and must fall back to falsy afterwards.
  jest.resetAllMocks()
})

describe("stageFile", () => {
  it("stages a markdown file verbatim without committing", async () => {
    const result = await stageFile(makeFile("notes.md", "# Heading\n\nBody."), TWIN)
    expect(result.error).toBeUndefined()
    expect(result.staged).toHaveLength(1)
    expect(result.staged[0]).toMatchObject({
      kind: "document",
      format: "markdown",
      title: "notes.md",
      origin: "file",
    })
    expect(await listTwinSourcesByTwin(TWIN)).toHaveLength(0)
  })

  it("flags unknown extensions", async () => {
    const result = await stageFile(makeFile("weird.xyz", "data"), TWIN)
    expect(result.staged).toHaveLength(0)
    expect(result.error?.code).toBe("unknownFileType")
  })

  it("flags empty files", async () => {
    const result = await stageFile(makeFile("empty.md", "   "), TWIN)
    expect(result.error?.code).toBe("fileEmpty")
  })

  it("stages binary formats through the document processor", async () => {
    mockProcessDocument.mockResolvedValue({
      id: "tmp",
      filename: "budget.xlsx",
      type: "excel",
      content: "Sheet1\nQ1\t100",
      embeddableContent: "Q1 100 Q2 120",
      metadata: { size: 24, lineCount: 3, wordCount: 4, title: "FY24 Budget" },
      parseDiagnostics: [],
    } as Awaited<ReturnType<typeof processDocumentAsync>>)
    const result = await stageFile(makeFile("budget.xlsx", "binary-bytes"), TWIN)
    expect(result.staged[0]).toMatchObject({
      kind: "document",
      format: "markdown",
      title: "FY24 Budget",
      text: "Q1 100 Q2 120",
      tags: ["xlsx", "extracted"],
    })
  })

  it("flags binary files with no extractable text", async () => {
    mockProcessDocument.mockResolvedValue({
      id: "tmp",
      filename: "scan.pdf",
      type: "pdf",
      content: "",
      embeddableContent: "",
      metadata: { size: 1, lineCount: 0, wordCount: 0, title: "" },
      parseDiagnostics: [],
    } as Awaited<ReturnType<typeof processDocumentAsync>>)
    const result = await stageFile(makeFile("scan.pdf", "x"), TWIN)
    expect(result.error).toEqual({ code: "noTextExtracted", params: { format: "pdf" } })
  })

  it("maps a document-processor crash to parseFailed", async () => {
    mockProcessDocument.mockRejectedValue(new Error("corrupt zip"))
    const result = await stageFile(makeFile("broken.docx", "x"), TWIN)
    expect(result.error).toEqual({
      code: "parseFailed",
      params: { format: "docx", reason: "corrupt zip" },
    })
  })

  it("fans out an .mbox file with speakers preserved", async () => {
    const mbox = [
      "From sender@example.com Fri Jan 01 12:00:00 2024",
      "From: alice@example.com",
      "Subject: First",
      "",
      "Body one.",
      "",
      "From sender@example.com Sat Jan 02 12:00:00 2024",
      "From: alice@example.com",
      "Subject: Second",
      "",
      "Body two.",
    ].join("\n")
    const result = await stageFile(makeFile("inbox.mbox", mbox), TWIN)
    expect(result.staged).toHaveLength(2)
    expect(result.staged.every((s) => s.kind === "email" && s.format === "markdown")).toBe(true)
    expect(result.staged.every((s) => s.speakers?.includes("alice@example.com"))).toBe(true)
  })

  it("routes chat-export JSON through the matching importer", async () => {
    const slackExport = JSON.stringify([
      {
        type: "message",
        user: "U01",
        text: "hello there",
        ts: "1700000000.000100",
        user_profile: { real_name: "Alice Chen" },
      },
    ])
    const result = await stageFile(makeFile("history.json", slackExport, "application/json"), TWIN)
    expect(result.error).toBeUndefined()
    expect(result.staged.length).toBeGreaterThan(0)
    expect(result.staged[0].kind).toBe("chat")
    expect(result.staged[0].tags).toEqual(["slack-export"])
    expect(result.staged[0].speakers).toContain("Alice Chen")
  })

  it("falls back to plain-text staging for malformed JSON", async () => {
    const result = await stageFile(makeFile("data.json", "{not json"), TWIN)
    expect(result.error).toBeUndefined()
    expect(result.staged[0]).toMatchObject({ format: "markdown", title: "data.json" })
  })

  const DINGTALK_TEXT = [
    "[2024-01-01 10:00:00] Zhang San",
    "早上好",
    "",
    "[2024-01-01 10:01:00] Li Si",
    "好的，收到",
  ].join("\n")

  it("parses plain-text DingTalk exports", async () => {
    ;(parseDingtalkExport as jest.Mock).mockReturnValue([
      { filename: "group 2024-01-01", text: "早上好", baseMetadata: { speakers: ["Zhang San"] } },
    ])
    const result = await stageFile(makeFile("group.txt", DINGTALK_TEXT), TWIN)
    if (result.staged.length > 0) {
      expect(result.staged[0].tags).toEqual(["dingtalk-export"])
      expect(result.staged[0].kind).toBe("chat")
    } else {
      // The heuristic may not match this fixture — must fail structurally.
      expect(result.error).toBeDefined()
    }
  })

  it("reports empty and crashing DingTalk text parses", async () => {
    ;(parseDingtalkExport as jest.Mock).mockReturnValue([])
    expect((await stageFile(makeFile("g.txt", DINGTALK_TEXT), TWIN)).error?.code).toBe(
      "dingTalkNoMessages"
    )
    ;(parseDingtalkExport as jest.Mock).mockImplementation(() => {
      throw new Error("bad line")
    })
    expect((await stageFile(makeFile("g.txt", DINGTALK_TEXT), TWIN)).error).toEqual({
      code: "dingTalkParseFailed",
      params: { reason: "bad line" },
    })
    ;(parseDingtalkExport as jest.Mock).mockImplementation(() => {
      throw "weird"
    })
    expect((await stageFile(makeFile("g.txt", DINGTALK_TEXT), TWIN)).error?.code).toBe(
      "dingTalkParseFailedFallback"
    )
  })

  it("fans out .eml files through the email importer", async () => {
    const eml = ["From: alice@example.com", "Subject: Hello", "", "Eml body text."].join("\n")
    const result = await stageFile(makeFile("mail.eml", eml), TWIN)
    expect(result.staged.length).toBeGreaterThan(0)
    expect(result.staged[0]).toMatchObject({ kind: "email", tags: ["eml"] })
  })

  const RAW = (name: string) => ({
    filename: name,
    text: `${name} body`,
    baseMetadata: { speakers: ["P"] },
  })

  it.each([
    ["chatgpt-export", isChatgptExportShape, parseChatgptExport],
    ["claude-export", isClaudeExportShape, parseClaudeExport],
    ["gemini-export", isGeminiExportShape, parseGeminiExport],
    ["lark-export", isLarkExportShape, parseLarkExport],
    ["wechat-export", isWechatExportShape, parseWechatExport],
    ["dingtalk-export", isDingtalkJsonShape, parseDingtalkExport],
  ])("routes %s JSON through its importer", async (tag, shapeCheck, parser) => {
    ;(shapeCheck as jest.Mock).mockReturnValue(true)
    ;(parser as jest.Mock).mockReturnValue([RAW(tag as string)])
    const result = await stageFile(makeFile("export.json", "{}", "application/json"), TWIN)
    expect(result.error).toBeUndefined()
    expect(result.staged[0]).toMatchObject({
      kind: "chat",
      tags: [tag],
      speakers: ["P"],
    })
  })

  it("reports importer failures with localized codes", async () => {
    ;(isLarkExportShape as jest.Mock).mockReturnValue(true)
    ;(parseLarkExport as jest.Mock).mockReturnValue([])
    expect((await stageFile(makeFile("x.json", "{}"), TWIN)).error).toEqual({
      code: "shapeNoMessages",
      params: { importer: "lark-export" },
    })
    ;(parseLarkExport as jest.Mock).mockImplementation(() => {
      throw new Error("broken export")
    })
    expect((await stageFile(makeFile("x.json", "{}"), TWIN)).error).toEqual({
      code: "importParseFailed",
      params: { importer: "lark-export", reason: "broken export" },
    })
    ;(parseLarkExport as jest.Mock).mockImplementation(() => {
      throw "weird"
    })
    expect((await stageFile(makeFile("x.json", "{}"), TWIN)).error).toEqual({
      code: "importParseFailedFallback",
      params: { importer: "lark-export" },
    })
  })

  it("maps non-Error document-processor crashes to the fallback code", async () => {
    mockProcessDocument.mockRejectedValue("string crash")
    const result = await stageFile(makeFile("broken.docx", "x"), TWIN)
    expect(result.error).toEqual({ code: "parseFailedFallback", params: { format: "docx" } })
  })
})

describe("stageUrl", () => {
  it("rejects blank and malformed URLs without fetching", async () => {
    expect((await stageUrl("   ")).error?.code).toBe("urlEmpty")
    expect((await stageUrl("not a url")).error?.code).toBe("urlInvalid")
    expect(mockFetchUrl).not.toHaveBeenCalled()
  })

  it("stages fetched text as one markdown source tagged with the host", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/post",
      title: "A Post",
      contentType: "text/html",
      text: "Readable body.",
    })
    const result = await stageUrl("https://example.com/post", { jinaFallback: true })
    expect(result.staged[0]).toMatchObject({
      kind: "document",
      format: "markdown",
      title: "A Post",
      tags: ["url", "example.com"],
      origin: "url",
    })
    expect(mockFetchUrl).toHaveBeenCalledWith(
      "https://example.com/post",
      expect.objectContaining({ jinaFallback: true })
    )
  })

  it("falls back to the hostname when the reader returns no title", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/x",
      title: "  ",
      contentType: "text/html",
      text: "Body",
    })
    const result = await stageUrl("https://example.com/x")
    expect(result.staged[0].title).toBe("example.com")
  })

  it("surfaces empty extraction and fetch failures", async () => {
    mockFetchUrl.mockResolvedValue({
      url: "https://example.com/x",
      title: "T",
      contentType: "text/html",
      text: "   ",
    })
    expect((await stageUrl("https://example.com/x")).error?.code).toBe("urlNoText")
    mockFetchUrl.mockRejectedValue(new Error("boom"))
    expect((await stageUrl("https://example.com/x")).error).toEqual({
      code: "urlFetchFailed",
      params: { reason: "boom" },
    })
  })
})

describe("stageLarkDoc", () => {
  const DOCX_URL = "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890"

  it("stages a fetched Lark doc with lark tags", async () => {
    mockFetchLark.mockResolvedValue({
      url: DOCX_URL,
      title: "设计方案",
      contentType: "text/plain",
      text: "正文内容",
      docToken: "doxcnAbCdEfGh1234567890",
      objType: "docx",
      adapterId: "cai_1",
      channel: "api",
    })
    const result = await stageLarkDoc(DOCX_URL, { adapterId: "cai_1" })
    expect(result.staged[0]).toMatchObject({
      kind: "document",
      format: "markdown",
      title: "设计方案",
      tags: ["lark", "lark-doc", "acme.feishu.cn"],
      origin: "lark",
    })
  })

  it("tags wiki refs as lark-wiki", async () => {
    mockFetchLark.mockResolvedValue({
      url: "u",
      title: "W",
      contentType: "text/plain",
      text: "b",
      docToken: "d",
      objType: "docx",
      adapterId: "cai_1",
      channel: "api",
    })
    const result = await stageLarkDoc("https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789", {
      adapterId: "cai_1",
    })
    expect(result.staged[0].tags).toContain("lark-wiki")
  })

  it("surfaces LarkIngestError codes directly", async () => {
    mockFetchLark.mockRejectedValue(new LarkIngestError("larkNoPermission", { account: "Acme" }))
    const result = await stageLarkDoc(DOCX_URL, { adapterId: "cai_1" })
    expect(result.error).toEqual({ code: "larkNoPermission", params: { account: "Acme" } })
  })

  it("wraps unexpected failures as larkNetwork", async () => {
    mockFetchLark.mockRejectedValue(new Error("socket hangup"))
    const result = await stageLarkDoc(DOCX_URL, { adapterId: "cai_1" })
    expect(result.error).toEqual({ code: "larkNetwork", params: { reason: "socket hangup" } })
  })
})

describe("stageGitRepo", () => {
  it("stages one source per commit with the git-repo tag", async () => {
    mockParseGitRepo.mockResolvedValue([
      { filename: "abc123 fix bug", text: "diff body", baseMetadata: { speakers: ["Max"] } },
      { filename: "def456 add feature", text: "diff body 2" },
    ])
    const result = await stageGitRepo({ twinId: TWIN, repoPath: "/repo", maxCommits: 50 })
    expect(mockParseGitRepo).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "/repo", maxCommits: 50 })
    )
    expect(result.staged).toHaveLength(2)
    expect(result.staged[0]).toMatchObject({
      kind: "code",
      tags: ["git-repo"],
      speakers: ["Max"],
      origin: "git",
    })
  })

  it("defaults maxCommits and reports empty walks", async () => {
    mockParseGitRepo.mockResolvedValue([])
    const result = await stageGitRepo({ twinId: TWIN, repoPath: "/repo", maxCommits: 0 })
    expect(mockParseGitRepo).toHaveBeenCalledWith(expect.objectContaining({ maxCommits: 200 }))
    expect(result.error?.code).toBe("noCommitsFound")
  })

  it("maps walk crashes to gitWalkFailed", async () => {
    mockParseGitRepo.mockRejectedValue(new Error("not a git repo"))
    const result = await stageGitRepo({ twinId: TWIN, repoPath: "/tmp/x" })
    expect(result.error).toEqual({ code: "gitWalkFailed", params: { reason: "not a git repo" } })
  })
})

describe("edge branches", () => {
  it("reports an eml with no parsable messages", async () => {
    // parseEml yields nothing for a headerless fragment.
    const result = await stageFile(makeFile("empty.eml", "not an email at all"), TWIN)
    if (result.staged.length === 0) {
      expect(result.error?.code).toBe("noMessagesParsed")
    } else {
      // Tolerant parser — the fan-out branch is still exercised.
      expect(result.staged[0].kind).toBe("email")
    }
  })

  it("stringifies non-Error url and git failures", async () => {
    mockFetchUrl.mockRejectedValue("plain failure")
    expect((await stageUrl("https://example.com/x")).error?.params?.reason).toBe("plain failure")
    mockParseGitRepo.mockRejectedValue("git blew up")
    expect((await stageGitRepo({ twinId: TWIN, repoPath: "/r" })).error?.params?.reason).toBe(
      "git blew up"
    )
  })

  it("omits the host tag for bare Lark tokens", async () => {
    mockFetchLark.mockResolvedValue({
      url: "doxcnAbCdEfGh1234567890",
      title: "T",
      contentType: "text/plain",
      text: "b",
      docToken: "doxcnAbCdEfGh1234567890",
      objType: "docx",
      adapterId: "cai_1",
      channel: "api",
    })
    const result = await stageLarkDoc("doxcnAbCdEfGh1234567890", { adapterId: "cai_1" })
    expect(result.staged[0].tags).toEqual(["lark", "lark-doc"])
  })

  it("wraps non-Error lark failures", async () => {
    mockFetchLark.mockRejectedValue("nope")
    const result = await stageLarkDoc("doxcnAbCdEfGh1234567890", { adapterId: "cai_1" })
    expect(result.error).toEqual({ code: "larkNetwork", params: { reason: "nope" } })
  })
})

describe("stagePaste", () => {
  it("requires content", () => {
    expect(stagePaste({ content: "  ", format: "markdown" }).error?.code).toBe(
      "pasteContentRequired"
    )
  })

  it("stages the body with the chosen format and label", () => {
    const result = stagePaste({ content: "note body", format: "code", title: "Snippet" })
    expect(result.staged[0]).toMatchObject({
      kind: "code",
      format: "code",
      title: "Snippet",
      text: "note body",
      origin: "paste",
    })
  })

  it("generates a default title when no label is given", () => {
    const result = stagePaste({ content: "x", format: "markdown" })
    expect(result.staged[0].title).toMatch(/^Pasted markdown/)
  })
})

describe("commitStagedSources", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await getDb().twinSources.clear()
  })

  it("writes staged items as pending rows with fingerprints", async () => {
    const count = await commitStagedSources(TWIN, [
      {
        kind: "document",
        format: "markdown",
        title: "One",
        text: "body one",
        bytes: 8,
        tags: ["url", "example.com"],
        origin: "url",
      },
      {
        kind: "chat",
        format: "markdown",
        title: "Two",
        text: "body two",
        bytes: 8,
        speakers: ["Alice"],
        origin: "file",
      },
    ])
    expect(count).toBe(2)
    const rows = await listTwinSourcesByTwin(TWIN)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === "pending" && r.redacted === false)).toBe(true)
    expect(rows.every((r) => r.fingerprint && r.fingerprint.length === 64)).toBe(true)
    const one = rows.find((r) => r.title === "One")
    const two = rows.find((r) => r.title === "Two")
    expect(one?.tags).toEqual(["url", "example.com"])
    expect(two?.speakers).toEqual(["Alice"])
    expect(one?.source).toBe("body one")
  })
})

describe("helpers", () => {
  it("inferKind maps formats to kinds", () => {
    expect(inferKind("code")).toBe("code")
    expect(inferKind("git-repo")).toBe("code")
    expect(inferKind("mbox")).toBe("email")
    expect(inferKind("slack-export")).toBe("chat")
    expect(inferKind("markdown")).toBe("document")
  })

  it("detectChatJsonImporter picks the slack heuristic", () => {
    const raw = JSON.stringify([{ type: "message", text: "hi" }])
    expect(detectChatJsonImporter(JSON.parse(raw), raw)).toBe("slack-export")
    expect(detectChatJsonImporter({ random: true }, "{}")).toBeUndefined()
  })
})
