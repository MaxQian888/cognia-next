/**
 * Fixed bilingual golden set for memory retrieval evaluation
 * (`./retrieval-eval.ts`). Synthetic, PII-free, and small enough to read in one
 * sitting — every question's gold answer is checkable by eye.
 *
 * Categories:
 * - `fact` — direct lexical questions about a durable fact.
 * - `preference` — how the user likes things done.
 * - `paraphrase` — the question shares few words with the answer.
 * - `cjk` — Chinese questions and memories.
 * - `episode` — asks about a past conversation ("上次" / "last time"); the gold
 *   answer is an episodic memory competing with a semantic fact on the same
 *   subject.
 * - `corroborated` — two memories answer; the one confirmed across more
 *   conversations is the gold answer.
 * - `historical` — asked `asOf` a past instant; memories created later or
 *   forgotten earlier must not answer, and an edited memory answers with the
 *   wording it had then.
 */

import type { Memory, MemoryType } from "../types/memory"
import type { RetrievalEvalDataset, RetrievalEvalQuestion } from "./retrieval-eval"

const DAY = 24 * 60 * 60 * 1000
export const GOLDEN_NOW = Date.UTC(2026, 8, 1)

let snapshotSeq = 0

function mem(
  id: string,
  type: MemoryType,
  text: string,
  over: Partial<Memory> & { ageDays?: number } = {}
): Memory {
  const { ageDays = 30, ...rest } = over
  const createdAt = GOLDEN_NOW - ageDays * DAY
  return {
    id,
    scope: "global",
    type,
    text,
    tags: [],
    importance: 5,
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    vectorDocId: id,
    reviewStatus: type === "procedural" ? "verified" : "unreviewed",
    ...rest,
  }
}

/** A revision snapshot of `owner` whose text was live over `[from, to)`. */
function snapshot(owner: Memory, text: string, from: number, to: number): Memory {
  snapshotSeq += 1
  return {
    ...owner,
    id: `${owner.id}__rev${snapshotSeq}`,
    text,
    status: "invalidated",
    invalidatedAt: to,
    supersededById: owner.id,
    revisionOf: owner.id,
    revisionReason: "edit",
    revisedAt: from,
    updatedAt: to,
    vectorDocId: undefined,
    accessCount: 0,
  }
}

const editor = mem("m-editor", "semantic", "Writes code in the Zed editor with vim keybindings.", {
  ageDays: 300,
  revisedAt: Date.UTC(2026, 5, 15),
})

export const GOLDEN_MEMORIES: Memory[] = [
  // Facts
  mem("m-pnpm", "semantic", "Uses pnpm as the package manager for every JavaScript project.", {
    beliefInputs: { evidenceCount: 5, distinctSessions: 4, newestEvidenceAt: GOLDEN_NOW - 5 * DAY },
  }),
  // Same age and wording overlap as m-pnpm: only corroboration separates them.
  mem("m-npm-side", "semantic", "Uses the npm package manager for JavaScript side projects.", {
    beliefInputs: {
      evidenceCount: 1,
      distinctSessions: 1,
      newestEvidenceAt: GOLDEN_NOW - 30 * DAY,
    },
  }),
  mem("m-tz", "semantic", "Lives in the Asia/Shanghai time zone (UTC+8)."),
  mem("m-lang", "semantic", "Main programming languages are TypeScript and Rust."),
  mem("m-db", "semantic", "The desktop app stores local data in IndexedDB through Dexie."),
  mem(
    "m-ci",
    "semantic",
    "Continuous integration runs on GitHub Actions with a self-hosted macOS runner."
  ),
  mem("m-test", "semantic", "Unit tests use Jest with co-located test files."),
  mem("m-vector", "semantic", "Embeddings are cached in a local sqlite-vec vector store."),
  mem("m-deploy", "semantic", "The marketing site is deployed to Cloudflare Pages."),
  mem("m-coffee", "semantic", "Drinks oat-milk flat whites; no sugar."),
  mem("m-cat", "semantic", "Has a cat named Miso."),
  mem("m-os", "semantic", "Daily machine is an Apple Silicon MacBook Pro running macOS."),
  editor,
  mem("m-nvim", "semantic", "Switched to Neovim when editing on remote servers.", { ageDays: 40 }),
  // Preferences (procedural, verified)
  mem("m-commits", "procedural", "Write commit messages in Conventional Commits format.", {
    reviewStatus: "verified",
  }),
  mem("m-concise", "procedural", "Keep answers short and lead with the conclusion.", {
    reviewStatus: "verified",
  }),
  mem("m-tabs", "procedural", "Format code with two-space indentation, never tabs.", {
    reviewStatus: "verified",
  }),
  mem("m-zh-questions", "procedural", "用中文提问确认问题，用英文写代码注释。", {
    reviewStatus: "verified",
  }),
  // Chinese facts
  mem("m-zh-city", "semantic", "用户住在杭州，周末喜欢去西湖跑步。"),
  mem("m-zh-work", "semantic", "用户在一家做开发者工具的公司担任前端负责人。"),
  mem("m-zh-diet", "semantic", "用户对花生过敏，点餐时要避开花生。"),
  mem("m-zh-reading", "semantic", "用户最近在读《设计数据密集型应用》。"),
  // Episodes competing with facts on the same subject
  mem(
    "m-ep-cache",
    "episodic",
    "Last session we decided to cache query embeddings for one hour to cut embedding cost.",
    { ageDays: 3 }
  ),
  mem(
    "m-ep-release",
    "episodic",
    "上次会话中我们决定把发布流程改成本地执行 changeset version，而不是用 CI 发布。",
    { ageDays: 6 }
  ),
  mem("m-release-fact", "semantic", "Releases are versioned with Changesets.", { ageDays: 120 }),
  mem(
    "m-ep-flaky",
    "episodic",
    "Yesterday we traced the flaky Jest suite to a shared fake-indexeddb instance and isolated it.",
    { ageDays: 1 }
  ),
  mem("m-ep-trip", "episodic", "Planned a hiking trip to Huangshan for the October holiday.", {
    ageDays: 12,
  }),
  // A fact and an episode that share the query's words equally: only the
  // question's "last time" says which one is wanted.
  mem("m-localdb-fact", "semantic", "The local database is IndexedDB accessed through Dexie.", {
    ageDays: 5,
  }),
  mem("m-ep-localdb", "episodic", "We reviewed the local database setup and kept Dexie.", {
    ageDays: 5,
  }),
  // Forgotten before the historical instant — must never answer an asOf question.
  mem("m-old-editor", "semantic", "Writes code in Sublime Text.", {
    ageDays: 500,
    status: "invalidated",
    invalidatedAt: Date.UTC(2025, 11, 1),
  }),
]

GOLDEN_MEMORIES.push(
  snapshot(
    editor,
    "Writes code in VS Code with the default keybindings.",
    editor.createdAt,
    editor.revisedAt!
  )
)

export const GOLDEN_QUESTIONS: RetrievalEvalQuestion[] = [
  {
    id: "q-pnpm",
    query: "Which package manager do I use for JavaScript?",
    relevantIds: ["m-pnpm"],
    category: "corroborated",
  },
  { id: "q-tz", query: "What time zone am I in?", relevantIds: ["m-tz"], category: "fact" },
  {
    id: "q-lang",
    query: "What programming languages do I mainly use?",
    relevantIds: ["m-lang"],
    category: "fact",
  },
  {
    id: "q-db",
    query: "Where does the desktop app store local data?",
    relevantIds: ["m-db"],
    category: "fact",
  },
  {
    id: "q-ci",
    query: "Which CI service runs our builds?",
    relevantIds: ["m-ci"],
    category: "fact",
  },
  {
    id: "q-test",
    query: "What test framework do we use?",
    relevantIds: ["m-test"],
    category: "fact",
  },
  {
    id: "q-deploy",
    query: "Where is the marketing site deployed?",
    relevantIds: ["m-deploy"],
    category: "fact",
  },
  { id: "q-cat", query: "What's my cat called?", relevantIds: ["m-cat"], category: "fact" },
  {
    id: "q-os",
    query: "What laptop and operating system do I use every day?",
    relevantIds: ["m-os"],
    category: "fact",
  },
  {
    id: "q-editor-now",
    query: "Which code editor do I write code in?",
    relevantIds: ["m-editor"],
    category: "fact",
  },
  {
    id: "q-commits",
    query: "How should commit messages be formatted?",
    relevantIds: ["m-commits"],
    category: "preference",
    types: ["procedural"],
  },
  {
    id: "q-concise",
    query: "How long should answers be?",
    relevantIds: ["m-concise"],
    category: "preference",
    types: ["procedural"],
  },
  {
    id: "q-indent",
    query: "Tabs or spaces for indentation?",
    relevantIds: ["m-tabs"],
    category: "preference",
    types: ["procedural"],
  },
  {
    id: "q-coffee",
    query: "How do I take my coffee?",
    relevantIds: ["m-coffee"],
    category: "paraphrase",
  },
  {
    id: "q-remote",
    query: "What do I edit files with on remote servers over SSH?",
    relevantIds: ["m-nvim"],
    category: "paraphrase",
  },
  {
    id: "q-vector",
    query: "Where are embeddings cached?",
    relevantIds: ["m-vector"],
    category: "fact",
  },
  { id: "q-zh-city", query: "我住在哪个城市？", relevantIds: ["m-zh-city"], category: "cjk" },
  {
    id: "q-zh-work",
    query: "我在公司里担任什么职位？",
    relevantIds: ["m-zh-work"],
    category: "cjk",
  },
  { id: "q-zh-diet", query: "我对什么食物过敏？", relevantIds: ["m-zh-diet"], category: "cjk" },
  {
    id: "q-zh-reading",
    query: "我最近在读什么书？",
    relevantIds: ["m-zh-reading"],
    category: "cjk",
  },
  {
    id: "q-zh-lang",
    query: "代码注释应该用什么语言写？",
    relevantIds: ["m-zh-questions"],
    category: "cjk",
    types: ["procedural"],
  },
  {
    id: "q-ep-cache",
    query: "What did we decide last time about caching embeddings?",
    relevantIds: ["m-ep-cache"],
    category: "episode",
  },
  {
    id: "q-ep-release",
    query: "上次我们决定的发布流程是什么？",
    relevantIds: ["m-ep-release"],
    category: "episode",
  },
  {
    id: "q-ep-flaky",
    query: "What did we find yesterday about the flaky Jest suite?",
    relevantIds: ["m-ep-flaky"],
    category: "episode",
  },
  {
    id: "q-ep-trip",
    query: "What trip did we plan last time?",
    relevantIds: ["m-ep-trip"],
    category: "episode",
  },
  {
    id: "q-ep-localdb",
    query: "What did we review last time about the local database?",
    relevantIds: ["m-ep-localdb"],
    category: "episode",
  },
  {
    id: "q-hist-editor",
    query: "Which code editor do I write code in?",
    relevantIds: ["m-editor"],
    category: "historical",
    asOf: Date.UTC(2026, 2, 1),
  },
  {
    id: "q-hist-vscode",
    // Only the earlier wording mentions VS Code; as of March it was the live text.
    query: "Do I write code in VS Code?",
    relevantIds: ["m-editor"],
    category: "historical",
    asOf: Date.UTC(2026, 2, 1),
  },
]

/**
 * Historical questions that must retrieve NOTHING: the only matching memory was
 * learned after the instant (Neovim, 40 days before GOLDEN_NOW) or forgotten
 * before it (Sublime Text). Kept out of the scored set — an empty gold list
 * scores as a miss — and asserted directly by the eval test.
 */
export const GOLDEN_NEGATIVE_HISTORICAL: RetrievalEvalQuestion[] = [
  {
    id: "q-hist-remote",
    query: "Neovim remote servers",
    relevantIds: [],
    category: "historical",
    asOf: Date.UTC(2026, 2, 1),
  },
  {
    id: "q-hist-sublime",
    query: "Sublime Text",
    relevantIds: [],
    category: "historical",
    asOf: Date.UTC(2026, 2, 1),
  },
]

export const GOLDEN_DATASET: RetrievalEvalDataset = {
  memories: GOLDEN_MEMORIES,
  questions: GOLDEN_QUESTIONS,
  now: GOLDEN_NOW,
}
