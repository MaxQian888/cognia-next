/** Capture and import real Gemini recording-service output without provider credentials. */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { geminiCliSessionSource, parseGeminiChat } from "@/lib/session-import/adapters/gemini-cli"

async function main() {
  const coreRoot = process.argv[2]
  assert.ok(coreRoot, "Pass the installed @google/gemini-cli-core directory")
  const installedRoot = path.resolve(coreRoot)
  const installed = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"))
  assert.equal(installed.name, "@google/gemini-cli-core")
  assert.equal(installed.version, "0.61.0", "This acceptance certifies the bundled 0.61.0 release")
  const { ChatRecordingService, loadConversationRecord } = await import(
    pathToFileURL(path.join(installedRoot, "dist/src/services/chatRecordingService.js")).href
  )
  const outputRoot = path.resolve(process.argv[3] ?? ".cache/gemini-history-acceptance")
  fs.mkdirSync(outputRoot, { recursive: true })
  const runRoot = fs.mkdtempSync(path.join(outputRoot, "recording-"))
  const scratchpad = {
    version: 1,
    workflowSummary: "Inspected the public fixture",
    toolSequence: ["read_file"],
    touchedPaths: ["/workspace/fixture.ts"],
    validationStatus: "passed",
  }
  const startedAt = new Date().toISOString()
  const seed = {
    sessionId: "gemini-0.61.0-acceptance",
    projectHash: "public-fixture",
    startTime: startedAt,
    lastUpdated: startedAt,
    kind: "main",
    directories: ["/workspace/gemini-fixture"],
    memoryScratchpad: scratchpad,
    messages: [],
  }
  const legacyPath = path.join(runRoot, "session.json")
  fs.writeFileSync(legacyPath, JSON.stringify(seed))
  const recording = new ChatRecordingService({
    promptId: seed.sessionId,
    config: { getProjectRoot: () => "/workspace/gemini-fixture" },
    toolRegistry: {
      getTool: () => ({ displayName: "Read fixture", description: "Read a public fixture" }),
    },
  })
  await recording.initialize({ conversation: seed, filePath: legacyPath })
  recording.recordMessage({
    id: "user-1",
    type: "user",
    content: [{ text: "Inspect the public fixture" }],
  })
  recording.recordThought({ subject: "Inspect", description: "Read the fixture first" })
  recording.recordMessageTokens({
    promptTokenCount: 12,
    candidatesTokenCount: 6,
    cachedContentTokenCount: 3,
    thoughtsTokenCount: 2,
    toolUsePromptTokenCount: 1,
    totalTokenCount: 21,
  })
  recording.recordMessage({
    id: "assistant-1",
    type: "gemini",
    model: "gemini-fixture",
    content: [{ text: "Fixture inspected" }],
  })
  recording.recordToolCalls("gemini-fixture", [
    {
      id: "read-fixture",
      name: "read_file",
      args: { file_path: "/workspace/fixture.ts" },
      result: [{ text: "export const fixture = true" }],
      status: "success",
      timestamp: new Date().toISOString(),
      agentId: "fixture-reader",
    },
  ])
  recording.recordMessage({ id: "discarded", type: "user", content: "discarded turn" })
  recording.rewindTo("discarded")
  recording.saveSummary("Public fixture inspected")
  const recordedPath = recording.getConversationFilePath()
  assert.ok(recordedPath)
  const upstream = await loadConversationRecord(recordedPath)
  assert.ok(upstream)
  const content = fs.readFileSync(recordedPath, "utf8")
  const parsed = parseGeminiChat(content, recordedPath)
  assert.equal(parsed.originalSessionId, upstream.sessionId)
  assert.equal(parsed.messages.length, upstream.messages.length)
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.summary, upstream.summary)
  const [summary] = await geminiCliSessionSource.listSessions({
    home: "",
    pickedFiles: [{ name: "session.jsonl", path: recordedPath, content }],
    fs: {
      exists: async () => false,
      readDir: async () => [],
      stat: async () => ({ size: content.length, isFile: true }),
      readTextFile: async () => content,
    },
  })
  assert.ok(summary)
  assert.deepEqual(JSON.parse(parsed.memoryScratchpad!), upstream.memoryScratchpad)
  assert.ok(parsed.messages[1].parts.some((part) => part.type === "tool-read_file"))
  assert.ok(parsed.messages[1].parts.some((part) => part.type === "reasoning"))
  const fixturePath = path.join(runRoot, "gemini-0.61.0-session.jsonl")
  fs.writeFileSync(fixturePath, content)
  console.log(
    JSON.stringify(
      {
        version: installed.version,
        fixturePath,
        messages: parsed.messages.length,
        upstreamLoaderMatches: true,
        structuredScratchpad: true,
        providerInference: false,
      },
      null,
      2
    )
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
