// In-memory workspace for the project editor's Storybook stories. Implements
// the same `ProjectEditorDeps` contract the workspace-fs transport does — the
// editor, tree, quick-open and search run their production code paths against
// it, and every mutation emits a real watcher event, so the watch → flag →
// banner chain (agent edits, deletes, save conflicts) is exercised end to end
// in a plain browser. Only the bytes live in a Map instead of on disk.
//
// Never imported by app code: without a desktop or remote host the dock
// states "workspace unavailable" rather than inventing a filesystem.

import type { ProjectEditorDeps } from "@/components/editor/project/use-project-editor"
import type { ProjectGitStatusDeps } from "@/components/editor/project/use-project-git-status"
import type { ProjectQuickOpenDeps } from "@/components/editor/project/project-quick-open"
import type { ProjectSearchDeps } from "@/components/editor/project/project-search-panel"
import type { WorkspaceContentMatch, WorkspaceEntry, WorkspaceStat } from "@/lib/files/types"
import type { WorkspaceWalkOptions, WorkspaceWalkResult } from "@/lib/files/workspace-fs"
import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"
import type { GitFileStatus, GitStatus } from "@/types/git"

export const MOCK_WORKSPACE_ROOT = "/mock/sample-app"

interface MockFile {
  content: string
  mtimeMs: number
}

type WatchHandler = (change: WorkspaceFsChange) => void

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function normalizeRel(relPath: string): string {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (rel.split("/").includes("..")) {
    throw new Error(`path escapes the workspace root: ${relPath}`)
  }
  return rel
}

function parentOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/")
  return slash < 0 ? "" : relPath.slice(0, slash)
}

export interface MockWorkspace {
  root: string
  /** `deps` for `useProjectEditorWorkbench` — the editor + tree surface. */
  deps: Partial<ProjectEditorDeps>
  /** `deps` for `ProjectQuickOpen` — the file index. */
  quickOpenDeps: Partial<ProjectQuickOpenDeps>
  /** `deps` for `ProjectSearchPanel` — content search. */
  searchDeps: Partial<ProjectSearchDeps>
  /** `gitDeps` for `ProjectEditorFileWorkbench` — branch + decorations. */
  gitDeps: Partial<ProjectGitStatusDeps>
  /** Seed or overwrite a file without a watcher echo (fixture setup). */
  seed: (relPath: string, content: string) => void
}

const SEED: Record<string, string> = {
  "package.json": `{
  "name": "sample-app",
  "private": true,
  "version": "0.3.1",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "typescript": "^5.8.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"]
}
`,
  ".gitignore": `node_modules
dist
*.local
.DS_Store
`,
  "README.md": `# sample-app

A tiny React app used to exercise the project editor stories.

## Scripts

- \`pnpm dev\` — start the dev server
- \`pnpm test\` — run the unit tests
- \`pnpm build\` — production build

## Layout

\`src/\` holds the application. State lives in zustand stores under
\`src/stores/\`; shared helpers live in \`src/lib/\`.
`,
  "src/main.tsx": `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
`,
  "src/App.tsx": `import { useCounterStore } from "./stores/counter"
import { Button } from "./components/Button"
import { Card } from "./components/Card"

export function App() {
  const count = useCounterStore((s) => s.count)
  const increment = useCounterStore((s) => s.increment)

  return (
    <main className="app">
      <Card title="Counter">
        <p>Current value: {count}</p>
        <Button onClick={increment}>Increment</Button>
      </Card>
    </main>
  )
}
`,
  "src/components/Button.tsx": `import type { ButtonHTMLAttributes, ReactNode } from "react"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

export function Button({ children, ...rest }: ButtonProps) {
  return (
    <button className="btn" type="button" {...rest}>
      {children}
    </button>
  )
}
`,
  "src/components/Card.tsx": `import type { ReactNode } from "react"

interface CardProps {
  title: string
  children: ReactNode
}

export function Card({ title, children }: CardProps) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="card-body">{children}</div>
    </section>
  )
}
`,
  "src/stores/counter.ts": `import { create } from "zustand"

interface CounterState {
  count: number
  increment: () => void
  reset: () => void
}

export const useCounterStore = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
  reset: () => set({ count: 0 }),
}))
`,
  "src/lib/utils.ts": `export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return \`\${(count / 1_000_000).toFixed(1)}M\`
  if (count >= 1_000) return \`\${(count / 1_000).toFixed(1)}k\`
  return String(count)
}
`,
  "src/lib/api.ts": `export interface Todo {
  id: number
  title: string
  done: boolean
}

export async function fetchTodos(): Promise<Todo[]> {
  const res = await fetch("/api/todos")
  if (!res.ok) throw new Error(\`todos request failed: \${res.status}\`)
  return res.json() as Promise<Todo[]>
}
`,
  "src/styles.css": `:root {
  color-scheme: light dark;
}

.app {
  display: grid;
  place-items: center;
  min-height: 100vh;
}

.card {
  border: 1px solid #8884;
  border-radius: 8px;
  padding: 1rem 1.25rem;
}

.btn {
  padding: 0.4rem 0.9rem;
  border-radius: 6px;
}
`,
  "src/types.ts": `export interface User {
  id: string
  name: string
  email: string
}

export type Theme = "light" | "dark" | "system"
`,
  "tests/utils.test.ts": `import { describe, expect, it } from "vitest"
import { clamp, formatCount } from "../src/lib/utils"

describe("clamp", () => {
  it("bounds the value", () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
  })
})

describe("formatCount", () => {
  it("abbreviates large numbers", () => {
    expect(formatCount(1_500)).toBe("1.5k")
  })
})
`,
  "docs/architecture.md": `# Architecture

The app is a single-page React bundle. State flows one way:

1. Components read from zustand stores.
2. Actions on the stores produce the next state.
3. \`src/lib/api.ts\` owns every network call.

Keep components presentational — no fetch calls inside \`.tsx\` files.
`,
  "src/notes/todo.md": `# TODO

- [ ] wire the counter to the API
- [ ] dark-mode toggle
- [ ] persist state to localStorage
`,
}

export function createMockWorkspace(
  seed: Record<string, string> = SEED,
  root: string = MOCK_WORKSPACE_ROOT
): MockWorkspace {
  const files = new Map<string, MockFile>()
  const dirs = new Set<string>([""])
  const watchers = new Set<WatchHandler>()
  const gitSubscribers = new Set<(event: { rootDir: string }) => void>()
  /** Working-tree status the seed repo claims — chaos writes update it live. */
  const gitChanges = new Map<string, { status: GitFileStatus; origPath: string | null }>([
    ["src/lib/utils.ts", { status: "modified", origPath: null }],
    ["src/notes/todo.md", { status: "untracked", origPath: null }],
  ])
  let gitPingQueued = false

  const absolute = (rel: string) => (rel ? `${root}/${rel}` : root)

  const entryFor = (rel: string, isDir: boolean, size = 0, mtimeMs: number | null = null) =>
    ({
      relPath: rel,
      absolutePath: absolute(rel),
      isDir,
      size,
      mtimeMs,
    }) satisfies WorkspaceEntry

  const ensureParents = (rel: string) => {
    let parent = parentOf(rel)
    while (true) {
      if (!dirs.has(parent)) dirs.add(parent)
      if (!parent) break
      parent = parentOf(parent)
    }
  }

  const pingGit = () => {
    if (gitPingQueued) return
    gitPingQueued = true
    setTimeout(() => {
      gitPingQueued = false
      for (const handler of gitSubscribers) handler({ rootDir: root })
    }, 0)
  }

  const emit = (kind: WorkspaceFsChange["kind"], rel: string) => {
    // Native watchers deliver after the write syscall returns — keep the same
    // ordering so "write resolves, then the change event lands" holds.
    const path = absolute(rel)
    setTimeout(() => {
      for (const handler of watchers) handler({ kind, path })
    }, 0)
    pingGit()
  }

  const seedPaths = new Set(Object.keys(seed).map(normalizeRel))

  /** A path counts as tracked once the seed shipped it or it was already
      reported modified/renamed — deleting or editing it stays reportable. */
  const tracked = (rel: string) => {
    const prior = gitChanges.get(rel)?.status
    return seedPaths.has(rel) || prior === "modified" || prior === "renamed"
  }

  const markWritten = (rel: string, existed: boolean) => {
    const prior = gitChanges.get(rel)?.status
    gitChanges.set(rel, {
      status:
        prior === "untracked" ? "untracked" : existed || tracked(rel) ? "modified" : "untracked",
      origPath: null,
    })
  }

  const markDeleted = (rel: string) => {
    if (tracked(rel)) gitChanges.set(rel, { status: "deleted", origPath: null })
    else gitChanges.delete(rel)
  }

  const write = (rel: string, content: string, silent: boolean) => {
    const existed = files.has(rel)
    ensureParents(rel)
    files.set(rel, { content, mtimeMs: Date.now() })
    if (silent) return
    markWritten(rel, existed)
    emit(existed ? "modify" : "create", rel)
  }

  for (const [rel, content] of Object.entries(seed)) write(normalizeRel(rel), content, true)

  const listDir = async (
    _root: string,
    relPath?: string,
    _includeIgnored?: boolean
  ): Promise<WorkspaceEntry[]> => {
    const parent = normalizeRel(relPath ?? "")
    const out: WorkspaceEntry[] = []
    for (const dir of dirs) {
      if (dir && parentOf(dir) === parent) out.push(entryFor(dir, true, 0, null))
    }
    for (const [rel, file] of files) {
      if (parentOf(rel) === parent) {
        out.push(entryFor(rel, false, encoder.encode(file.content).byteLength, file.mtimeMs))
      }
    }
    return out
  }

  const statFile = async (_root: string, relPath: string): Promise<WorkspaceStat> => {
    const rel = normalizeRel(relPath)
    const file = files.get(rel)
    if (file) {
      return {
        exists: true,
        isDir: false,
        size: encoder.encode(file.content).byteLength,
        mtimeMs: file.mtimeMs,
      }
    }
    if (dirs.has(rel)) return { exists: true, isDir: true, size: 0, mtimeMs: null }
    return { exists: false, isDir: false, size: 0, mtimeMs: null }
  }

  const readFile = async (_root: string, relPath: string, maxBytes?: number): Promise<string> => {
    const file = files.get(normalizeRel(relPath))
    if (!file) throw new Error(`ENOENT: ${relPath}`)
    const bytes = encoder.encode(file.content)
    return decoder.decode(maxBytes !== undefined ? bytes.subarray(0, maxBytes) : bytes)
  }

  const readFileBase64 = async (
    _root: string,
    relPath: string,
    maxBytes?: number
  ): Promise<string> => {
    const file = files.get(normalizeRel(relPath))
    if (!file) throw new Error(`ENOENT: ${relPath}`)
    const bytes = encoder.encode(file.content)
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new Error(`file exceeds maxBytes: ${relPath}`)
    }
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  const writeFile = async (_root: string, relPath: string, content: string) => {
    write(normalizeRel(relPath), content, false)
  }

  const createDir = async (_root: string, relPath: string) => {
    const rel = normalizeRel(relPath)
    if (!rel) return
    ensureParents(`${rel}/.dir`)
    dirs.add(rel)
    emit("create", rel)
  }

  const deleteEntry = async (_root: string, relPath: string, recursive?: boolean) => {
    const rel = normalizeRel(relPath)
    if (files.delete(rel)) {
      markDeleted(rel)
      emit("delete", rel)
      return
    }
    if (!dirs.has(rel)) throw new Error(`ENOENT: ${relPath}`)
    const prefix = `${rel}/`
    const children = [...files.keys()].filter((p) => p === rel || p.startsWith(prefix))
    if (children.length && !recursive) {
      throw new Error(`directory not empty: ${relPath}`)
    }
    for (const child of children) {
      files.delete(child)
      markDeleted(child)
    }
    for (const dir of [...dirs]) {
      if (dir === rel || dir.startsWith(prefix)) dirs.delete(dir)
    }
    // A recursive watcher may collapse a subtree removal to the directory's
    // own event — the editor prefix-matches either way.
    emit("delete", rel)
  }

  const renameEntry = async (_root: string, fromRelPath: string, toRelPath: string) => {
    const from = normalizeRel(fromRelPath)
    const to = normalizeRel(toRelPath)
    if (files.has(to) || dirs.has(to)) throw new Error(`destination exists: ${toRelPath}`)
    if (to === from || to.startsWith(`${from}/`)) {
      throw new Error(`cannot move ${fromRelPath} inside itself`)
    }
    const markRenamed = (fromRel: string, toRel: string) => {
      gitChanges.set(toRel, {
        status: tracked(fromRel) ? "renamed" : "untracked",
        origPath: tracked(fromRel) ? fromRel : null,
      })
      gitChanges.delete(fromRel)
    }
    const file = files.get(from)
    if (file) {
      files.delete(from)
      write(to, file.content, true)
      markRenamed(from, to)
    } else if (dirs.has(from)) {
      const prefix = `${from}/`
      for (const [rel, child] of [...files]) {
        if (rel.startsWith(prefix)) {
          files.delete(rel)
          const moved = `${to}/${rel.slice(prefix.length)}`
          files.set(moved, child)
          markRenamed(rel, moved)
        }
      }
      for (const dir of [...dirs]) {
        if (dir === from || dir.startsWith(prefix)) {
          dirs.delete(dir)
          dirs.add(`${to}${dir.slice(from.length)}`)
        }
      }
      ensureParents(to)
    } else {
      throw new Error(`ENOENT: ${fromRelPath}`)
    }
    emit("delete", from)
    emit("create", to)
  }

  const walk = async (
    _root: string,
    options: WorkspaceWalkOptions = {}
  ): Promise<WorkspaceWalkResult> => {
    const base = normalizeRel(options.relPath ?? "")
    const prefix = base ? `${base}/` : ""
    const maxDepth = options.maxDepth ?? 24
    const cap = options.maxEntries ?? 5000
    const entries: WorkspaceEntry[] = []
    const inScope = (rel: string) => rel.startsWith(prefix) || (!base && !!rel)
    const withinDepth = (rel: string) => rel.slice(prefix.length).split("/").length <= maxDepth
    if (options.includeDirs) {
      for (const dir of dirs) {
        if (dir && inScope(dir) && withinDepth(dir)) entries.push(entryFor(dir, true))
      }
    }
    for (const [rel, file] of files) {
      if (inScope(rel) && withinDepth(rel)) {
        entries.push(entryFor(rel, false, encoder.encode(file.content).byteLength, file.mtimeMs))
      }
    }
    const truncated = entries.length > cap
    return { entries: entries.slice(0, cap), truncated, skippedSensitive: 0 }
  }

  const search = async (
    _root: string,
    query: string,
    options: { isRegex?: boolean; caseSensitive?: boolean; maxResults?: number } = {}
  ): Promise<WorkspaceContentMatch[]> => {
    if (!query) return []
    const needle = options.isRegex ? new RegExp(query, options.caseSensitive ? "g" : "gi") : null
    const plain = options.caseSensitive ? query : query.toLowerCase()
    const cap = Math.min(options.maxResults ?? 500, 500)
    const matches: WorkspaceContentMatch[] = []
    for (const [rel, file] of files) {
      const lines = file.content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        let column = -1
        if (needle) {
          needle.lastIndex = 0
          const hit = needle.exec(line)
          column = hit ? hit.index + 1 : -1
        } else {
          const hay = options.caseSensitive ? line : line.toLowerCase()
          const at = hay.indexOf(plain)
          column = at < 0 ? -1 : at + 1
        }
        if (column > 0) {
          matches.push({
            relPath: rel,
            absolutePath: absolute(rel),
            line: i + 1,
            column,
            preview: line.trim(),
          })
          if (matches.length >= cap) return matches
        }
      }
    }
    return matches
  }

  const gitStatus = async (): Promise<GitStatus> => ({
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    staged: [],
    changes: [...gitChanges]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, change]) => ({
        path,
        origPath: change.origPath,
        status: change.status,
        staged: false,
        group: "changes" as const,
      })),
    merge: [],
    isRebasing: false,
    isMerging: false,
  })

  return {
    root,
    deps: {
      listDir,
      readFile,
      readFileBase64,
      statFile,
      writeFile,
      createDir,
      deleteEntry,
      renameEntry,
      listWorktrees: async () => [],
      registerLspRoot: () => "",
      unregisterLspRoot: () => {},
      watch: (_root: string, onChange: WatchHandler) => {
        watchers.add(onChange)
        return () => watchers.delete(onChange)
      },
    },
    quickOpenDeps: { walk },
    searchDeps: { search },
    gitDeps: {
      gitStatus,
      gitRepoState: async (repoPath: string) => ({
        isRepo: true,
        rootDir: repoPath,
        detachedHead: false,
        operationInProgress: null,
      }),
      subscribeGitStatusChanged: (handler: (event: { rootDir: string }) => void) => {
        gitSubscribers.add(handler)
        return () => {
          gitSubscribers.delete(handler)
        }
      },
    },
    seed: (relPath, content) => write(normalizeRel(relPath), content, true),
  }
}
