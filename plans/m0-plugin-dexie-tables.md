# M0 — Plugin Dexie Tables 平台特性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let plugins declare their own Dexie tables via `manifest.dexie`, with namespaced names, runtime schema upgrades on plugin enable/upgrade, and lifecycle-aware data retention on disable/uninstall.

**Architecture:** Plugins declare tables in `manifest.dexie.tables[]`. At app boot, the `PluginManager` aggregates all enabled plugins' table declarations and applies them to the shared `CogniaDB` instance via a single `db.version(N).stores({...})` call where `N` starts at the static `LATEST_STATIC_VERSION + 1` (currently 27) and increments per plugin install. The next available version is persisted in a new built-in table `pluginDexieMeta`. Tables are namespaced as `<pluginId>:<tableName>` to prevent collisions. Plugin runtime gets table access via the existing `ctx.db` Proxy with a namespace-enforcing wrapper. On uninstall, data is retained by default; users can opt to purge via a settings UI button.

**Tech Stack:** TypeScript 5, Dexie 4, React 19 (settings UI), Jest + fake-indexeddb (tests), Fumadocs MDX (plugin-dev docs).

**Out of scope for M0** (pushed to M1+ or later):

- Migration safety rollback if upgrade callback throws (M0 throws + sets plugin error state; no rollback)
- Cross-plugin shared tables (always namespaced, no sharing)
- IndexedDB quota management UI
- Performance optimization for plugins declaring 100+ tables (cap at 20/plugin)

---

## File Structure

### New files

- `lib/plugin/dexie-bridge.ts` — table aggregation, version computation, db close→bump→reopen
- `lib/plugin/dexie-bridge.test.ts`
- `lib/plugin/dexie-meta.ts` — `pluginDexieMeta` Dexie helpers (read/write next version, retention prefs)
- `lib/plugin/dexie-meta.test.ts`
- `lib/plugin/dexie-namespace.ts` — pure helpers for namespace prefix
- `lib/plugin/dexie-namespace.test.ts`
- `lib/plugin/api/dexie-api.ts` — `ctx.dexie` API exposed to plugins (or extends `ctx.db` — Task 0 decides)
- `lib/plugin/api/dexie-api.test.ts`
- `lib/plugin/dexie-migration-runner.ts` — runs `manifest.dexie.migrations[]` once per (pluginId, toVersion)
- `lib/plugin/dexie-migration-runner.test.ts`
- `components/settings/plugins/plugin-data-management.tsx` — per-plugin "delete plugin data" UI
- `components/settings/plugins/plugin-data-management.test.tsx`
- `docs/content/docs/plugin-dev/dexie-tables.mdx`

### Modified files

- `types/plugin/plugin.ts` — add `PluginManifestDexieBlock`, `PluginDexieTableDef`, `PluginDexieMigrationDef`; extend `PluginManifest` with `dexie?:` field
- `lib/db/schema.ts` — add `pluginDexieMeta` table at version 27 (the LAST static version bump)
- `lib/plugin/core/validation.ts` — validate `manifest.dexie` block
- `lib/plugin/core/manager.ts` — call `applyPluginTables` in `enablePlugin`; `removePluginTables` in `uninstallPlugin` if user opts in
- `lib/plugin/core/context.ts` — wire `ctx.dexie` (or extend `ctx.db`) into `createPluginContext`
- `CLAUDE.md` — add "Plugin Dexie tables" section
- `docs/content/docs/plugin-dev/meta.json` — add the new doc page (if dir exists)

### Test fixtures

- `lib/plugin/__fixtures__/plugin-with-dexie-tables.ts` — minimal manifest for use across tests

---

## Conventions Applied

- **TDD**: every implementation task starts with a failing test
- **Co-located tests**: `xxx.ts` → `xxx.test.ts` next to source (per project CLAUDE.md)
- **Coverage target**: ≥ 90%
- **Commits**: Conventional Commits, after each task; test + impl in one commit
- **Branch**: `feat/plugin-dexie-tables` (create at start)

---

## Task 0: Investigate existing `PluginDatabaseAPI`

**Files:**

- Read: `lib/plugin/api/database.ts` (or wherever `createDatabaseAPI` lives — find via Grep)
- Read: `types/plugin/plugin.ts:944+` (`PluginContext.db` type definition)

This is a non-coding investigation task that decides whether subsequent tasks add `ctx.dexie` as a new sibling property or extend `ctx.db`.

- [ ] **Step 1: Locate `createDatabaseAPI`**

Run: Grep `pattern: "export function createDatabaseAPI"`, `output_mode: "files_with_matches"`

Expected: one match, likely `lib/plugin/api/database.ts`

- [ ] **Step 2: Read the file end-to-end and the `PluginDatabaseAPI` type**

Use Read tool on the file from step 1 and Read on `types/plugin/plugin.ts` around line 944 (search for `PluginDatabaseAPI` definition).

- [ ] **Step 3: Decide integration shape and document in this plan**

Edit this plan file inline at the bottom of Task 0 with one of:

- **Decision A**: `ctx.db` already provides plugin-scoped Dexie table access → extend `ctx.db.table()` to namespace-enforce, no new API surface
- **Decision B**: `ctx.db` is a different abstraction (e.g., SQLite via Tauri) → add new `ctx.dexie` API surface

Add a 3-line note explaining what the existing API does and which decision was made. **All later tasks reference "the dexie context API" without prejudging A vs B.**

- [ ] **Step 4: Commit decision note**

```bash
git checkout -b feat/plugin-dexie-tables
git add plans/m0-plugin-dexie-tables.md
git commit -m "docs(plan): record PluginDatabaseAPI investigation outcome"
```

---

## Task 1: Define manifest types

**Files:**

- Modify: `types/plugin/plugin.ts` (add 3 interfaces + extend `PluginManifest`)
- Test: `types/plugin/plugin.test.ts` (compile-time only — type-level test via `// @ts-expect-error`)

- [ ] **Step 1: Write the failing compile-time type test**

If `types/plugin/plugin.test.ts` does not exist, create it. Append:

```ts
// types/plugin/plugin.test.ts
import type { PluginManifest, PluginManifestDexieBlock } from "./plugin"

describe("PluginManifest.dexie", () => {
  it("accepts a valid dexie block", () => {
    const manifest: PluginManifest = {
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      description: "",
      type: "frontend",
      capabilities: [],
      main: "index.js",
      dexie: {
        tables: [
          { name: "items", schema: "++id, name" },
          { name: "events", schema: "deliveryId, [target+at]" },
        ],
      },
    }
    expect(manifest.dexie?.tables.length).toBe(2)
  })

  it("rejects table names with uppercase letters at compile time", () => {
    const block: PluginManifestDexieBlock = {
      tables: [
        // @ts-expect-error — name must match [a-z][a-zA-Z0-9_]*
        { name: "BadName", schema: "++id" },
      ],
    }
    void block
  })
})
```

Note: the second test only enforces the constraint if we encode it in the type via a branded string. For M0, **drop the second test** — the regex check is enforced at runtime in Task 2. Replace the second `it` block with a runtime placeholder commented `// regex enforced in validation.ts`.

- [ ] **Step 2: Run test to verify it fails (compile error)**

Run: `rtk pnpm test types/plugin/plugin.test.ts`

Expected: FAIL with "Property 'dexie' does not exist on type 'PluginManifest'" or "Cannot find name 'PluginManifestDexieBlock'"

- [ ] **Step 3: Add type definitions**

Edit `types/plugin/plugin.ts`. After the existing `PluginManifestWorkflowsBlock` interface (find via Grep), append:

```ts
/**
 * Plugin-declared Dexie tables. Tables are namespaced as
 * `<pluginId>:<tableName>` in the underlying CogniaDB instance.
 *
 * Plugins access their tables via `ctx.dexie.table<T>(name)` — the
 * pluginId prefix is stripped from the public name.
 */
export interface PluginManifestDexieBlock {
  /** Table declarations. Maximum 20 per plugin. */
  tables: PluginDexieTableDef[]
  /** Optional migration callbacks invoked once per (pluginId, toVersion). */
  migrations?: PluginDexieMigrationDef[]
}

export interface PluginDexieTableDef {
  /**
   * Logical table name without the pluginId prefix.
   * Must match `^[a-z][a-zA-Z0-9_]{0,30}$` — runtime-enforced.
   */
  name: string
  /**
   * Dexie schema string (same syntax as `db.version().stores({})` values).
   * Examples: "++id, name", "deliveryId, [target+at]".
   * `++id` is the conventional auto-incrementing primary key.
   */
  schema: string
}

export interface PluginDexieMigrationDef {
  /**
   * The manifest version (semver-ish integer) this migration upgrades to.
   * Runs when the plugin's previously-recorded version is < toVersion.
   */
  toVersion: number
  /**
   * Name of an exported function on the plugin module. Receives a
   * Dexie Transaction. Errors set the plugin into "error" state.
   */
  upgrade: string
}
```

Then locate the `PluginManifest` interface (around line 271–429 per investigation) and add the optional field. Find the existing `connectors?:` line and add nearby:

```ts
/** Plugin-declared Dexie tables. See `PluginManifestDexieBlock`. */
dexie?: PluginManifestDexieBlock
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test types/plugin/plugin.test.ts`

Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `rtk pnpm typecheck`

Expected: clean (no errors). If unrelated errors appear, do not fix them — surface to user.

- [ ] **Step 6: Commit**

```bash
git add types/plugin/plugin.ts types/plugin/plugin.test.ts
git commit -m "feat(plugin): declare PluginManifestDexieBlock manifest types"
```

---

## Task 2: Pure namespace helpers

**Files:**

- Create: `lib/plugin/dexie-namespace.ts`
- Test: `lib/plugin/dexie-namespace.test.ts`

These are pure functions used everywhere. No side effects, easy to unit test.

- [ ] **Step 1: Write the failing tests**

Create `lib/plugin/dexie-namespace.test.ts`:

```ts
import {
  toNamespacedTableName,
  fromNamespacedTableName,
  isValidPluginTableName,
  PLUGIN_TABLE_NAMESPACE_SEPARATOR,
  MAX_TABLES_PER_PLUGIN,
} from "./dexie-namespace"

describe("dexie-namespace", () => {
  describe("toNamespacedTableName", () => {
    it("joins pluginId and tableName with a colon", () => {
      expect(toNamespacedTableName("github-delivery", "repos")).toBe("github-delivery:repos")
    })
  })

  describe("fromNamespacedTableName", () => {
    it("splits on the first colon only (pluginId may not contain colons)", () => {
      expect(fromNamespacedTableName("github-delivery:repos")).toEqual({
        pluginId: "github-delivery",
        tableName: "repos",
      })
    })
    it("returns null for non-namespaced names", () => {
      expect(fromNamespacedTableName("messages")).toBeNull()
    })
  })

  describe("isValidPluginTableName", () => {
    it.each([
      ["repos", true],
      ["workOrders", true],
      ["a", true],
      ["a1_b", true],
      ["", false],
      ["1starts_with_digit", false],
      ["StartsUpper", false],
      ["has-dash", false],
      ["has space", false],
      ["a".repeat(32), false], // 31 max after the leading char => 32 total fails
    ])("name=%s → %s", (name, expected) => {
      expect(isValidPluginTableName(name)).toBe(expected)
    })
  })

  it("exposes constants", () => {
    expect(PLUGIN_TABLE_NAMESPACE_SEPARATOR).toBe(":")
    expect(MAX_TABLES_PER_PLUGIN).toBe(20)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test lib/plugin/dexie-namespace.test.ts`

Expected: FAIL with "Cannot find module './dexie-namespace'"

- [ ] **Step 3: Implement**

Create `lib/plugin/dexie-namespace.ts`:

```ts
export const PLUGIN_TABLE_NAMESPACE_SEPARATOR = ":" as const
export const MAX_TABLES_PER_PLUGIN = 20

const NAME_REGEX = /^[a-z][a-zA-Z0-9_]{0,30}$/

export function isValidPluginTableName(name: string): boolean {
  return typeof name === "string" && NAME_REGEX.test(name)
}

export function toNamespacedTableName(pluginId: string, tableName: string): string {
  return `${pluginId}${PLUGIN_TABLE_NAMESPACE_SEPARATOR}${tableName}`
}

export function fromNamespacedTableName(
  namespaced: string
): { pluginId: string; tableName: string } | null {
  const sep = namespaced.indexOf(PLUGIN_TABLE_NAMESPACE_SEPARATOR)
  if (sep <= 0 || sep === namespaced.length - 1) return null
  return {
    pluginId: namespaced.slice(0, sep),
    tableName: namespaced.slice(sep + 1),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-namespace.test.ts`

Expected: PASS, all 12+ test cases green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/dexie-namespace.ts lib/plugin/dexie-namespace.test.ts
git commit -m "feat(plugin): add dexie-namespace pure helpers"
```

---

## Task 3: Manifest validation for `dexie` block

**Files:**

- Modify: `lib/plugin/core/validation.ts` (add validation logic)
- Modify: `lib/plugin/core/validation.test.ts` (add test cases — find file via Glob first)

- [ ] **Step 1: Locate the validation test file**

Run: `Glob: "lib/plugin/core/validation.test.ts"` — if exists, append. If not, create it.

- [ ] **Step 2: Write failing tests**

Append to `lib/plugin/core/validation.test.ts`:

```ts
import { validatePluginManifest } from "./validation"
import type { PluginManifest } from "@/types/plugin/plugin"

const baseManifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "test",
  name: "Test",
  version: "1.0.0",
  description: "",
  type: "frontend",
  capabilities: [],
  main: "index.js",
  ...overrides,
})

describe("validatePluginManifest — dexie block", () => {
  it("accepts a valid dexie block", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: { tables: [{ name: "items", schema: "++id, name" }] },
      })
    )
    expect(result.valid).toBe(true)
  })

  it("rejects table name with uppercase letter", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: { tables: [{ name: "Items", schema: "++id" }] },
      })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("dexie.tables[0].name"))).toBe(true)
  })

  it("rejects empty schema string", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: { tables: [{ name: "items", schema: "" }] },
      })
    )
    expect(result.valid).toBe(false)
  })

  it("rejects more than 20 tables", () => {
    const tables = Array.from({ length: 21 }, (_, i) => ({
      name: `t${i}`,
      schema: "++id",
    }))
    const result = validatePluginManifest(baseManifest({ dexie: { tables } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === "manifest.dexie.tables.tooMany")).toBe(true)
  })

  it("rejects duplicate table names within one plugin", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: {
          tables: [
            { name: "items", schema: "++id" },
            { name: "items", schema: "++id, name" },
          ],
        },
      })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === "manifest.dexie.tables.duplicate")).toBe(true)
  })

  it("rejects migration with non-positive toVersion", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: {
          tables: [{ name: "items", schema: "++id" }],
          migrations: [{ toVersion: 0, upgrade: "migrateV0" }],
        },
      })
    )
    expect(result.valid).toBe(false)
  })

  it("rejects migration with empty upgrade name", () => {
    const result = validatePluginManifest(
      baseManifest({
        dexie: {
          tables: [{ name: "items", schema: "++id" }],
          migrations: [{ toVersion: 2, upgrade: "" }],
        },
      })
    )
    expect(result.valid).toBe(false)
  })

  it("allows omitting the dexie block entirely", () => {
    const result = validatePluginManifest(baseManifest())
    expect(result.valid).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `rtk pnpm test lib/plugin/core/validation.test.ts`

Expected: FAIL — `result.valid` is `true` for invalid blocks (validator hasn't been taught yet)

- [ ] **Step 4: Add validation logic**

Open `lib/plugin/core/validation.ts`. Find the existing block validations (e.g., `if (m.modes && Array.isArray(m.modes)) { ... }` around line 330 per Task 0 investigation). Add a new block immediately after the last existing optional-block check, **before the `return` statement**:

```ts
import { isValidPluginTableName, MAX_TABLES_PER_PLUGIN } from "@/lib/plugin/dexie-namespace"

// ... inside validatePluginManifest, after other optional blocks:

if (m.dexie !== undefined) {
  const dexie = m.dexie as Record<string, unknown>

  if (!Array.isArray(dexie.tables)) {
    pushError("dexie.tables", "manifest.dexie.tables.missing", "dexie.tables must be an array")
  } else {
    if (dexie.tables.length === 0) {
      pushError("dexie.tables", "manifest.dexie.tables.empty", "dexie.tables must not be empty")
    }
    if (dexie.tables.length > MAX_TABLES_PER_PLUGIN) {
      pushError(
        "dexie.tables",
        "manifest.dexie.tables.tooMany",
        `dexie.tables exceeds the maximum of ${MAX_TABLES_PER_PLUGIN}`
      )
    }
    const seen = new Set<string>()
    for (let i = 0; i < dexie.tables.length; i++) {
      const t = dexie.tables[i] as Record<string, unknown>
      if (!isValidPluginTableName(t.name as string)) {
        pushError(
          `dexie.tables[${i}].name`,
          "manifest.dexie.tables.nameInvalid",
          `Table name at index ${i} is invalid: must match ^[a-z][a-zA-Z0-9_]{0,30}$`
        )
      } else if (seen.has(t.name as string)) {
        pushError(
          `dexie.tables[${i}].name`,
          "manifest.dexie.tables.duplicate",
          `Duplicate table name "${t.name}"`
        )
      } else {
        seen.add(t.name as string)
      }
      if (typeof t.schema !== "string" || t.schema.trim().length === 0) {
        pushError(
          `dexie.tables[${i}].schema`,
          "manifest.dexie.tables.schemaInvalid",
          `Table at index ${i} missing or empty "schema"`
        )
      }
    }
  }

  if (dexie.migrations !== undefined) {
    if (!Array.isArray(dexie.migrations)) {
      pushError(
        "dexie.migrations",
        "manifest.dexie.migrations.invalid",
        "dexie.migrations must be an array if provided"
      )
    } else {
      for (let i = 0; i < dexie.migrations.length; i++) {
        const mig = dexie.migrations[i] as Record<string, unknown>
        if (
          typeof mig.toVersion !== "number" ||
          mig.toVersion < 1 ||
          !Number.isInteger(mig.toVersion)
        ) {
          pushError(
            `dexie.migrations[${i}].toVersion`,
            "manifest.dexie.migrations.toVersionInvalid",
            `Migration at index ${i} requires positive integer "toVersion"`
          )
        }
        if (typeof mig.upgrade !== "string" || mig.upgrade.length === 0) {
          pushError(
            `dexie.migrations[${i}].upgrade`,
            "manifest.dexie.migrations.upgradeInvalid",
            `Migration at index ${i} requires non-empty "upgrade" function name`
          )
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/core/validation.test.ts`

Expected: PASS, 8 new test cases + existing tests still green

- [ ] **Step 6: Commit**

```bash
git add lib/plugin/core/validation.ts lib/plugin/core/validation.test.ts
git commit -m "feat(plugin): validate manifest.dexie block"
```

---

## Task 4: Add `pluginDexieMeta` table at static schema v27

**Files:**

- Modify: `lib/db/schema.ts` (add table interface + `db.version(27)` block + class field)
- Test: `lib/db/schema.test.ts` (add migration verification — find or create file)

This is the **last static version bump**. All later schema growth comes from plugin tables (dynamic versions ≥ 28).

- [ ] **Step 1: Read current schema tail**

Use Read on `lib/db/schema.ts` from line 850 to end of file to see the final version block (currently `version(26)`) and the class field declarations.

- [ ] **Step 2: Write the failing test**

Find or create `lib/db/schema.test.ts`. Append:

```ts
import "fake-indexeddb/auto"
import { getDb } from "./schema"

describe("CogniaDB v27 — pluginDexieMeta", () => {
  beforeEach(async () => {
    // fake-indexeddb resets per process; explicit fresh-up for safety:
    const Dexie = (await import("dexie")).default
    await Dexie.delete("cognia-claude")
  })

  it("exposes pluginDexieMeta with the documented columns", async () => {
    const db = getDb()
    await db.open()
    expect(db.tables.find((t) => t.name === "pluginDexieMeta")).toBeDefined()
    const row = {
      pluginId: "test-plugin",
      lastAppliedDexieVersion: 27,
      lastAppliedManifestVersion: 1,
      retentionMode: "keep" as const,
      updatedAt: Date.now(),
    }
    await db.table("pluginDexieMeta").put(row)
    const out = await db.table("pluginDexieMeta").get("test-plugin")
    expect(out).toEqual(row)
    db.close()
  })
})
```

- [ ] **Step 3: Run test — should fail**

Run: `rtk pnpm test lib/db/schema.test.ts`

Expected: FAIL — table `pluginDexieMeta` not found

- [ ] **Step 4: Add the table interface, class field, and version block**

In `lib/db/schema.ts`:

1. Add the row type near other `DB*` interfaces (alphabetical or at end of interface block):

```ts
export interface DBPluginDexieMeta {
  /** PluginId (primary key). */
  pluginId: string
  /** The Dexie schema version at which this plugin's tables were last applied. */
  lastAppliedDexieVersion: number
  /** Manifest's plugin version at last apply, drives migration eligibility. */
  lastAppliedManifestVersion: number
  /** "keep" preserves data on uninstall; "purge" deletes on uninstall. */
  retentionMode: "keep" | "purge"
  updatedAt: number
}
```

2. Add the class field on `CogniaDB`:

```ts
pluginDexieMeta!: Dexie.Table<DBPluginDexieMeta, string>
```

3. Append the version block at the end (after `this.version(26).stores({...})`):

```ts
this.version(27).stores({
  pluginDexieMeta: "&pluginId, lastAppliedDexieVersion, updatedAt",
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk pnpm test lib/db/schema.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/schema.test.ts
git commit -m "feat(db): add pluginDexieMeta table at schema v27"
```

---

## Task 5: `dexie-meta` helpers

**Files:**

- Create: `lib/plugin/dexie-meta.ts`
- Test: `lib/plugin/dexie-meta.test.ts`

Thin wrappers over the `pluginDexieMeta` table. Pure I/O, no business logic.

- [ ] **Step 1: Write failing tests**

Create `lib/plugin/dexie-meta.test.ts`:

```ts
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  recordPluginApply,
  getPluginMeta,
  getMaxAppliedDexieVersion,
  setPluginRetentionMode,
  removePluginMeta,
} from "./dexie-meta"

describe("dexie-meta", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("records a plugin apply and reads it back", async () => {
    await recordPluginApply("github-delivery", { dexieVersion: 28, manifestVersion: 1 })
    const meta = await getPluginMeta("github-delivery")
    expect(meta).toMatchObject({
      pluginId: "github-delivery",
      lastAppliedDexieVersion: 28,
      lastAppliedManifestVersion: 1,
      retentionMode: "keep",
    })
  })

  it("returns max applied version across all plugins (or 27 if none)", async () => {
    expect(await getMaxAppliedDexieVersion()).toBe(27)
    await recordPluginApply("a", { dexieVersion: 28, manifestVersion: 1 })
    await recordPluginApply("b", { dexieVersion: 30, manifestVersion: 2 })
    expect(await getMaxAppliedDexieVersion()).toBe(30)
  })

  it("toggles retention mode without losing other fields", async () => {
    await recordPluginApply("a", { dexieVersion: 28, manifestVersion: 1 })
    await setPluginRetentionMode("a", "purge")
    const meta = await getPluginMeta("a")
    expect(meta?.retentionMode).toBe("purge")
    expect(meta?.lastAppliedDexieVersion).toBe(28)
  })

  it("removePluginMeta deletes the row", async () => {
    await recordPluginApply("a", { dexieVersion: 28, manifestVersion: 1 })
    await removePluginMeta("a")
    expect(await getPluginMeta("a")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test lib/plugin/dexie-meta.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `lib/plugin/dexie-meta.ts`:

```ts
import { getDb } from "@/lib/db/schema"
import type { DBPluginDexieMeta } from "@/lib/db/schema"

const STATIC_SCHEMA_VERSION = 27 as const

export async function recordPluginApply(
  pluginId: string,
  args: { dexieVersion: number; manifestVersion: number }
): Promise<void> {
  const db = getDb()
  const existing = await db.pluginDexieMeta.get(pluginId)
  await db.pluginDexieMeta.put({
    pluginId,
    lastAppliedDexieVersion: args.dexieVersion,
    lastAppliedManifestVersion: args.manifestVersion,
    retentionMode: existing?.retentionMode ?? "keep",
    updatedAt: Date.now(),
  })
}

export async function getPluginMeta(pluginId: string): Promise<DBPluginDexieMeta | undefined> {
  return getDb().pluginDexieMeta.get(pluginId)
}

export async function getMaxAppliedDexieVersion(): Promise<number> {
  const all = await getDb().pluginDexieMeta.toArray()
  if (all.length === 0) return STATIC_SCHEMA_VERSION
  return all.reduce(
    (max, row) => (row.lastAppliedDexieVersion > max ? row.lastAppliedDexieVersion : max),
    STATIC_SCHEMA_VERSION
  )
}

export async function setPluginRetentionMode(
  pluginId: string,
  mode: "keep" | "purge"
): Promise<void> {
  const db = getDb()
  const existing = await db.pluginDexieMeta.get(pluginId)
  if (!existing) {
    throw new Error(`No dexie meta row for plugin "${pluginId}"`)
  }
  await db.pluginDexieMeta.put({ ...existing, retentionMode: mode, updatedAt: Date.now() })
}

export async function removePluginMeta(pluginId: string): Promise<void> {
  await getDb().pluginDexieMeta.delete(pluginId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-meta.test.ts`

Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/dexie-meta.ts lib/plugin/dexie-meta.test.ts
git commit -m "feat(plugin): add dexie-meta helpers for plugin schema bookkeeping"
```

---

## Task 6: Core `applyPluginTables` (the schema bumping engine)

**Files:**

- Create: `lib/plugin/dexie-bridge.ts`
- Test: `lib/plugin/dexie-bridge.test.ts`

This is the heart of the feature. **Single function** that takes a list of (pluginId, manifest) and bumps Dexie schema once.

- [ ] **Step 1: Write the failing test (single-plugin case)**

Create `lib/plugin/dexie-bridge.test.ts`:

```ts
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import { applyPluginTables, type PluginTablesInput } from "./dexie-bridge"
import { getPluginMeta, getMaxAppliedDexieVersion } from "./dexie-meta"

describe("applyPluginTables — single plugin", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("creates namespaced tables and records meta", async () => {
    const input: PluginTablesInput[] = [
      {
        pluginId: "alpha",
        manifestVersion: 1,
        tables: [
          { name: "items", schema: "++id, name" },
          { name: "events", schema: "++id, [type+at]" },
        ],
      },
    ]
    await applyPluginTables(input)
    const db = getDb()
    expect(db.table("alpha:items")).toBeDefined()
    expect(db.table("alpha:events")).toBeDefined()
    const meta = await getPluginMeta("alpha")
    expect(meta?.lastAppliedDexieVersion).toBe(28) // first dynamic version above static 27
    expect(await getMaxAppliedDexieVersion()).toBe(28)
  })

  it("re-applying the same input is a no-op (idempotent)", async () => {
    const input: PluginTablesInput[] = [
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ]
    await applyPluginTables(input)
    const versionAfterFirst = await getMaxAppliedDexieVersion()
    await applyPluginTables(input)
    expect(await getMaxAppliedDexieVersion()).toBe(versionAfterFirst)
  })
})
```

- [ ] **Step 2: Run test — should fail (module missing)**

Run: `rtk pnpm test lib/plugin/dexie-bridge.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement minimal single-plugin path**

Create `lib/plugin/dexie-bridge.ts`:

```ts
import { getDb } from "@/lib/db/schema"
import { toNamespacedTableName } from "./dexie-namespace"
import { recordPluginApply, getMaxAppliedDexieVersion, getPluginMeta } from "./dexie-meta"
import type { PluginDexieTableDef } from "@/types/plugin/plugin"

export interface PluginTablesInput {
  pluginId: string
  /** The plugin's manifest.version parsed to integer (major only). */
  manifestVersion: number
  tables: PluginDexieTableDef[]
}

/**
 * Apply one or more plugins' table declarations to the shared CogniaDB.
 *
 * For each plugin whose declarations differ from the last-applied snapshot
 * (or that has no recorded apply), the database is closed, a new
 * `db.version(N)` block is added with the merged stores map, and the
 * database is reopened. All other plugins' tables are preserved across
 * the bump because Dexie cumulates versions.
 *
 * If all inputs are already up-to-date, this function is a no-op.
 */
export async function applyPluginTables(inputs: PluginTablesInput[]): Promise<void> {
  if (inputs.length === 0) return

  // Determine which inputs need a bump
  const needsBump: PluginTablesInput[] = []
  for (const input of inputs) {
    const meta = await getPluginMeta(input.pluginId)
    if (!meta || meta.lastAppliedManifestVersion < input.manifestVersion) {
      needsBump.push(input)
    }
  }
  if (needsBump.length === 0) return

  // Compute the next Dexie version
  const baseVersion = await getMaxAppliedDexieVersion()
  const nextVersion = baseVersion + 1

  // Build the stores map for this version (only NEW/CHANGED tables;
  // Dexie carries forward tables from prior versions automatically.)
  const stores: Record<string, string> = {}
  for (const input of needsBump) {
    for (const t of input.tables) {
      stores[toNamespacedTableName(input.pluginId, t.name)] = t.schema
    }
  }

  // Close → bump → reopen
  const db = getDb()
  if (db.isOpen()) db.close()
  db.version(nextVersion).stores(stores)
  await db.open()

  // Record meta for each bumped plugin
  for (const input of needsBump) {
    await recordPluginApply(input.pluginId, {
      dexieVersion: nextVersion,
      manifestVersion: input.manifestVersion,
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-bridge.test.ts`

Expected: PASS, 2 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/dexie-bridge.ts lib/plugin/dexie-bridge.test.ts
git commit -m "feat(plugin): add applyPluginTables single-plugin path"
```

---

## Task 7: `applyPluginTables` multi-plugin namespace isolation

**Files:**

- Modify: `lib/plugin/dexie-bridge.test.ts` (add multi-plugin test)

The implementation from Task 6 already supports multi-plugin in one call, but the namespace-isolation contract needs an explicit test.

- [ ] **Step 1: Add the failing test**

Append to `lib/plugin/dexie-bridge.test.ts`:

```ts
describe("applyPluginTables — multi-plugin isolation", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("two plugins declaring the same table name get isolated tables", async () => {
    await applyPluginTables([
      {
        pluginId: "alpha",
        manifestVersion: 1,
        tables: [{ name: "items", schema: "++id, name" }],
      },
      {
        pluginId: "beta",
        manifestVersion: 1,
        tables: [{ name: "items", schema: "++id, label" }],
      },
    ])
    const db = getDb()
    await db.table("alpha:items").put({ name: "alpha-row" })
    await db.table("beta:items").put({ label: "beta-row" })
    expect((await db.table("alpha:items").toArray()).length).toBe(1)
    expect((await db.table("beta:items").toArray()).length).toBe(1)
    // Confirm cross-namespace queries return nothing
    const alphaRow = await db.table("alpha:items").toArray()
    expect(alphaRow[0]).not.toHaveProperty("label")
  })

  it("applying plugin B after A keeps A's tables intact", async () => {
    await applyPluginTables([
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
    await getDb().table("alpha:items").put({ id: 1 })
    await applyPluginTables([
      { pluginId: "beta", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
    expect(await getDb().table("alpha:items").get(1)).toEqual({ id: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-bridge.test.ts`

Expected: PASS — implementation already handles this; test pins the contract

- [ ] **Step 3: Commit**

```bash
git add lib/plugin/dexie-bridge.test.ts
git commit -m "test(plugin): assert applyPluginTables multi-plugin isolation"
```

---

## Task 8: `removePluginTables` for purge-on-uninstall

**Files:**

- Modify: `lib/plugin/dexie-bridge.ts` (add `removePluginTables`)
- Modify: `lib/plugin/dexie-bridge.test.ts`

Note: Dexie does not support runtime _removal_ of tables (only addition). To purge data, we `clear()` all tables matching the prefix. The schema entries linger as empty tables — this is acceptable per the M0 scope.

- [ ] **Step 1: Write failing tests**

Append to `lib/plugin/dexie-bridge.test.ts`:

```ts
import { removePluginTables } from "./dexie-bridge"

describe("removePluginTables", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("clears all rows from tables namespaced under the pluginId", async () => {
    await applyPluginTables([
      {
        pluginId: "alpha",
        manifestVersion: 1,
        tables: [
          { name: "items", schema: "++id" },
          { name: "events", schema: "++id" },
        ],
      },
    ])
    const db = getDb()
    await db.table("alpha:items").put({ id: 1 })
    await db.table("alpha:events").put({ id: 1 })
    await removePluginTables("alpha")
    expect(await db.table("alpha:items").count()).toBe(0)
    expect(await db.table("alpha:events").count()).toBe(0)
  })

  it("does not touch other plugins' tables", async () => {
    await applyPluginTables([
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
      { pluginId: "beta", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
    const db = getDb()
    await db.table("alpha:items").put({ id: 1 })
    await db.table("beta:items").put({ id: 2 })
    await removePluginTables("alpha")
    expect(await db.table("beta:items").count()).toBe(1)
  })

  it("also removes the dexie-meta row", async () => {
    await applyPluginTables([
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
    await removePluginTables("alpha")
    expect(await getPluginMeta("alpha")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test — should fail**

Run: `rtk pnpm test lib/plugin/dexie-bridge.test.ts`

Expected: FAIL — `removePluginTables` not exported

- [ ] **Step 3: Implement**

Add to `lib/plugin/dexie-bridge.ts`:

```ts
import { fromNamespacedTableName, PLUGIN_TABLE_NAMESPACE_SEPARATOR } from "./dexie-namespace"
import { removePluginMeta } from "./dexie-meta"

export async function removePluginTables(pluginId: string): Promise<void> {
  const db = getDb()
  const prefix = `${pluginId}${PLUGIN_TABLE_NAMESPACE_SEPARATOR}`
  for (const table of db.tables) {
    if (table.name.startsWith(prefix)) {
      await table.clear()
    }
  }
  await removePluginMeta(pluginId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-bridge.test.ts`

Expected: PASS, all bridge tests green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/dexie-bridge.ts lib/plugin/dexie-bridge.test.ts
git commit -m "feat(plugin): add removePluginTables for purge-on-uninstall"
```

---

## Task 9: Migration runner

**Files:**

- Create: `lib/plugin/dexie-migration-runner.ts`
- Test: `lib/plugin/dexie-migration-runner.test.ts`

When `manifest.dexie.migrations[]` is present, run callbacks once per (pluginId, toVersion) on plugin enable.

- [ ] **Step 1: Write failing tests**

Create `lib/plugin/dexie-migration-runner.test.ts`:

```ts
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { runPluginDexieMigrations } from "./dexie-migration-runner"
import { recordPluginApply } from "./dexie-meta"
import type { PluginDexieMigrationDef } from "@/types/plugin/plugin"

const makeMigration = (toVersion: number, fnName: string): PluginDexieMigrationDef => ({
  toVersion,
  upgrade: fnName,
})

describe("runPluginDexieMigrations", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("runs migrations whose toVersion > lastApplied (in order)", async () => {
    await recordPluginApply("alpha", { dexieVersion: 28, manifestVersion: 1 })
    const calls: number[] = []
    const exports = {
      mig2: jest.fn(async () => {
        calls.push(2)
      }),
      mig3: jest.fn(async () => {
        calls.push(3)
      }),
    }
    await runPluginDexieMigrations(
      "alpha",
      [makeMigration(2, "mig2"), makeMigration(3, "mig3")],
      exports,
      /* newManifestVersion */ 3
    )
    expect(calls).toEqual([2, 3])
  })

  it("skips already-applied migrations", async () => {
    await recordPluginApply("alpha", { dexieVersion: 28, manifestVersion: 2 })
    const exports = {
      mig2: jest.fn(),
      mig3: jest.fn(async () => {}),
    }
    await runPluginDexieMigrations(
      "alpha",
      [makeMigration(2, "mig2"), makeMigration(3, "mig3")],
      exports,
      /* newManifestVersion */ 3
    )
    expect(exports.mig2).not.toHaveBeenCalled()
    expect(exports.mig3).toHaveBeenCalledTimes(1)
  })

  it("throws if upgrade name is not exported", async () => {
    await recordPluginApply("alpha", { dexieVersion: 28, manifestVersion: 1 })
    await expect(
      runPluginDexieMigrations("alpha", [makeMigration(2, "missingFn")], {} /* no exports */, 2)
    ).rejects.toThrow(/missingFn/)
  })

  it("propagates the migration's error and does not advance meta", async () => {
    await recordPluginApply("alpha", { dexieVersion: 28, manifestVersion: 1 })
    const exports = {
      bad: jest.fn(async () => {
        throw new Error("boom")
      }),
    }
    await expect(
      runPluginDexieMigrations("alpha", [makeMigration(2, "bad")], exports, 2)
    ).rejects.toThrow("boom")
  })

  it("is idempotent if no migrations are pending", async () => {
    await recordPluginApply("alpha", { dexieVersion: 28, manifestVersion: 5 })
    const exports = { mig2: jest.fn() }
    await runPluginDexieMigrations("alpha", [makeMigration(2, "mig2")], exports, 5)
    expect(exports.mig2).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test — should fail**

Run: `rtk pnpm test lib/plugin/dexie-migration-runner.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `lib/plugin/dexie-migration-runner.ts`:

```ts
import type { PluginDexieMigrationDef } from "@/types/plugin/plugin"
import { getPluginMeta, recordPluginApply } from "./dexie-meta"

export async function runPluginDexieMigrations(
  pluginId: string,
  migrations: PluginDexieMigrationDef[] | undefined,
  pluginExports: Record<string, unknown>,
  newManifestVersion: number
): Promise<void> {
  if (!migrations || migrations.length === 0) return

  const meta = await getPluginMeta(pluginId)
  const lastApplied = meta?.lastAppliedManifestVersion ?? 0

  const pending = migrations
    .filter((m) => m.toVersion > lastApplied)
    .sort((a, b) => a.toVersion - b.toVersion)

  for (const mig of pending) {
    const fn = pluginExports[mig.upgrade]
    if (typeof fn !== "function") {
      throw new Error(`Plugin "${pluginId}" migration upgrade "${mig.upgrade}" is not exported`)
    }
    await (fn as () => Promise<void>)()
    // Advance manifest version one step at a time to allow partial recovery
    await recordPluginApply(pluginId, {
      dexieVersion: meta?.lastAppliedDexieVersion ?? 27,
      manifestVersion: mig.toVersion,
    })
  }

  // If newManifestVersion exceeds the last migration target, still advance
  const finalRecorded = (await getPluginMeta(pluginId))?.lastAppliedManifestVersion ?? 0
  if (newManifestVersion > finalRecorded) {
    await recordPluginApply(pluginId, {
      dexieVersion: meta?.lastAppliedDexieVersion ?? 27,
      manifestVersion: newManifestVersion,
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/dexie-migration-runner.test.ts`

Expected: PASS, 5 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/dexie-migration-runner.ts lib/plugin/dexie-migration-runner.test.ts
git commit -m "feat(plugin): add dexie migration runner with one-shot semantics"
```

---

## Task 10: Plugin context dexie API (namespace-enforcing)

**Files:**

- Create: `lib/plugin/api/dexie-api.ts`
- Test: `lib/plugin/api/dexie-api.test.ts`

This is the surface plugins import: `ctx.dexie.table<T>(name)`. Per Task 0 outcome, this either becomes an extension to existing `ctx.db` (Decision A) or a new sibling (Decision B). Naming below assumes Decision B; if Decision A, rename `createDexieAPI` → `extendDatabaseAPI` and adjust.

- [ ] **Step 1: Write failing tests**

Create `lib/plugin/api/dexie-api.test.ts`:

```ts
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { applyPluginTables } from "@/lib/plugin/dexie-bridge"
import { createDexieAPI } from "./dexie-api"

describe("createDexieAPI", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
    await applyPluginTables([
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
      { pluginId: "beta", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
  })

  it("table('items') returns the namespaced alpha:items for alpha", async () => {
    const api = createDexieAPI("alpha")
    const table = api.table<{ id: number }>("items")
    await table.put({ id: 1 })
    expect(await table.get(1)).toEqual({ id: 1 })
  })

  it("alpha cannot read beta's data", async () => {
    const apiAlpha = createDexieAPI("alpha")
    const apiBeta = createDexieAPI("beta")
    await apiBeta.table<{ id: number }>("items").put({ id: 99 })
    expect(await apiAlpha.table<{ id: number }>("items").count()).toBe(0)
  })

  it("throws when accessing a table the plugin did not declare", () => {
    const api = createDexieAPI("alpha")
    expect(() => api.table("undeclaredTable")).toThrow(/not declared/)
  })

  it("rawDb returns the underlying CogniaDB", async () => {
    const api = createDexieAPI("alpha")
    const db = await api.rawDb()
    expect(db.tables.find((t) => t.name === "alpha:items")).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test — should fail**

Run: `rtk pnpm test lib/plugin/api/dexie-api.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `lib/plugin/api/dexie-api.ts`:

```ts
import type Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  toNamespacedTableName,
  PLUGIN_TABLE_NAMESPACE_SEPARATOR,
} from "@/lib/plugin/dexie-namespace"

export interface PluginDexieAPI {
  table<T = unknown>(logicalName: string): Dexie.Table<T, unknown>
  rawDb(): Promise<Dexie>
}

export function createDexieAPI(pluginId: string): PluginDexieAPI {
  const prefix = `${pluginId}${PLUGIN_TABLE_NAMESPACE_SEPARATOR}`
  return {
    table<T = unknown>(logicalName: string): Dexie.Table<T, unknown> {
      const db = getDb()
      const namespaced = toNamespacedTableName(pluginId, logicalName)
      const exists = db.tables.some((t) => t.name === namespaced)
      if (!exists) {
        throw new Error(
          `Plugin "${pluginId}" attempted to access table "${logicalName}" ` +
            `(${namespaced}) but it was not declared in manifest.dexie.tables`
        )
      }
      // Safe cast: Dexie schema is dynamic; consumer supplies T at call site.
      return db.table(namespaced) as unknown as Dexie.Table<T, unknown>
    },
    async rawDb() {
      const db = getDb()
      if (!db.isOpen()) await db.open()
      // We deliberately return the full db; namespacing is enforced at table()
      // and via the documented rule "do not touch tables outside your prefix".
      void prefix // keep prefix in scope; future enforcement may use it
      return db as unknown as Dexie
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/api/dexie-api.test.ts`

Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add lib/plugin/api/dexie-api.ts lib/plugin/api/dexie-api.test.ts
git commit -m "feat(plugin): add ctx.dexie API with namespace enforcement"
```

---

## Task 11: Wire `ctx.dexie` into `createPluginContext`

**Files:**

- Modify: `lib/plugin/core/context.ts:131-154` (the `baseContext` object literal)
- Modify: `types/plugin/plugin.ts` (add `dexie: PluginDexieAPI` to `PluginContext` interface)
- Modify: existing `lib/plugin/core/context.test.ts` if present, else create

- [ ] **Step 1: Write failing test**

Find or create `lib/plugin/core/context.test.ts`. Append:

```ts
import { createPluginContext } from "./context"
import type { Plugin } from "@/types/plugin/plugin"

const stubManager = {} as never
const stubPlugin = {
  manifest: {
    id: "ctx-test",
    name: "X",
    version: "1.0.0",
    description: "",
    type: "frontend" as const,
    capabilities: [],
    main: "index.js",
  },
  path: "/tmp",
  config: {},
} as unknown as Plugin

describe("createPluginContext — dexie", () => {
  it("exposes ctx.dexie with table() and rawDb()", () => {
    const ctx = createPluginContext(stubPlugin, stubManager)
    expect(typeof ctx.dexie.table).toBe("function")
    expect(typeof ctx.dexie.rawDb).toBe("function")
  })
})
```

- [ ] **Step 2: Run test — should fail (TS compile error)**

Run: `rtk pnpm test lib/plugin/core/context.test.ts`

Expected: FAIL — `ctx.dexie` does not exist on `PluginContext`

- [ ] **Step 3: Add to `PluginContext` type**

In `types/plugin/plugin.ts`, find the `PluginContext` interface (line 944+) and add:

```ts
import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
// ... inside PluginContext:
dexie: PluginDexieAPI
```

- [ ] **Step 4: Wire into `createPluginContext`**

In `lib/plugin/core/context.ts`, near the top:

```ts
import { createDexieAPI } from "@/lib/plugin/api/dexie-api"
```

Inside `createPluginContext`'s `baseContext` literal (line 131–154), after `db: createDatabaseAPI(pluginId),` add:

```ts
dexie: createDexieAPI(pluginId),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/core/context.test.ts && rtk pnpm typecheck`

Expected: PASS + clean typecheck

- [ ] **Step 6: Commit**

```bash
git add types/plugin/plugin.ts lib/plugin/core/context.ts lib/plugin/core/context.test.ts
git commit -m "feat(plugin): wire ctx.dexie into createPluginContext"
```

---

## Task 12: Hook `applyPluginTables` into `enablePlugin`

**Files:**

- Modify: `lib/plugin/core/manager.ts` (`enablePlugin`, around line 953–1008)
- Modify: existing `lib/plugin/core/manager.test.ts`

The hook must run **after `loadPlugin` (so we have manifest)** and **before `registerPluginContributions` (so plugin contribution code can query its tables)**.

- [ ] **Step 1: Read the current `enablePlugin` body**

Use Read on `lib/plugin/core/manager.ts` lines 950–1010 to see the exact step ordering.

- [ ] **Step 2: Write failing test**

Append to `lib/plugin/core/manager.test.ts`:

```ts
import { applyPluginTables } from "@/lib/plugin/dexie-bridge"

jest.mock("@/lib/plugin/dexie-bridge", () => ({
  applyPluginTables: jest.fn(),
  removePluginTables: jest.fn(),
}))

describe("PluginManager.enablePlugin — dexie tables hook", () => {
  it("calls applyPluginTables when manifest declares dexie tables", async () => {
    // Use the existing test setup pattern from manager.test.ts to get a manager
    // instance with a mock plugin loaded. Reuse helpers like `createManifest()`.
    const manager = makeTestManager() // adapt to existing helper
    await manager.installPlugin("/tmp/test-with-dexie")
    await manager.enablePlugin("test-with-dexie")
    expect(applyPluginTables).toHaveBeenCalledWith([
      expect.objectContaining({ pluginId: "test-with-dexie" }),
    ])
  })

  it("skips applyPluginTables when manifest has no dexie block", async () => {
    const manager = makeTestManager()
    await manager.installPlugin("/tmp/test-no-dexie")
    await manager.enablePlugin("test-no-dexie")
    expect(applyPluginTables).not.toHaveBeenCalled()
  })
})
```

Note: this test relies on test helpers in the existing manager.test.ts. Read the file first to find `makeTestManager()` or equivalent. If absent, build a small `function makeTestManager()` inline that mirrors the existing setup pattern.

- [ ] **Step 3: Run test — should fail**

Run: `rtk pnpm test lib/plugin/core/manager.test.ts`

Expected: FAIL — `applyPluginTables` mock not called

- [ ] **Step 4: Modify `enablePlugin`**

In `lib/plugin/core/manager.ts`, inside `enablePlugin`, after step 1 (`loadPlugin`) and before step 3 (`registerPluginContributions`), insert:

```ts
import { applyPluginTables } from "@/lib/plugin/dexie-bridge"
import { runPluginDexieMigrations } from "@/lib/plugin/dexie-migration-runner"

// ... inside enablePlugin, after the loadPlugin call:

// Apply plugin-declared Dexie tables before contributions register so that
// node executors / connector adapters can immediately query their tables.
const pluginAfterLoad = store.plugins[pluginId]
if (pluginAfterLoad?.manifest.dexie?.tables) {
  await applyPluginTables([
    {
      pluginId,
      manifestVersion: parseManifestMajor(pluginAfterLoad.manifest.version),
      tables: pluginAfterLoad.manifest.dexie.tables,
    },
  ])
  // Run migrations if present (uses the plugin module's exported functions)
  if (pluginAfterLoad.manifest.dexie.migrations?.length) {
    const exports = this.loader.getExports(pluginId) ?? {}
    await runPluginDexieMigrations(
      pluginId,
      pluginAfterLoad.manifest.dexie.migrations,
      exports,
      parseManifestMajor(pluginAfterLoad.manifest.version)
    )
  }
}
```

Add a helper at the bottom of the file (or near other utilities):

```ts
function parseManifestMajor(version: string): number {
  const major = parseInt(version.split(".")[0] ?? "1", 10)
  return Number.isFinite(major) && major > 0 ? major : 1
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/core/manager.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/plugin/core/manager.ts lib/plugin/core/manager.test.ts
git commit -m "feat(plugin): apply plugin Dexie tables on enablePlugin"
```

---

## Task 13: Hook `removePluginTables` into `uninstallPlugin` (gated by retention mode)

**Files:**

- Modify: `lib/plugin/core/manager.ts` (`uninstallPlugin`)
- Modify: `lib/plugin/core/manager.test.ts`

Default retention is `"keep"`; only purge when `pluginDexieMeta.retentionMode === "purge"`.

- [ ] **Step 1: Locate `uninstallPlugin`**

Run: Grep `pattern: "async uninstallPlugin"` in `lib/plugin/core/manager.ts`, output_mode `content`, with `-n` and `-C 5`.

- [ ] **Step 2: Write failing test**

Append to `lib/plugin/core/manager.test.ts`:

```ts
import { removePluginTables } from "@/lib/plugin/dexie-bridge"
import { setPluginRetentionMode } from "@/lib/plugin/dexie-meta"

describe("PluginManager.uninstallPlugin — dexie cleanup", () => {
  it("calls removePluginTables when retentionMode is 'purge'", async () => {
    const manager = makeTestManager()
    await manager.installPlugin("/tmp/test-with-dexie")
    await manager.enablePlugin("test-with-dexie")
    await setPluginRetentionMode("test-with-dexie", "purge")
    await manager.uninstallPlugin("test-with-dexie")
    expect(removePluginTables).toHaveBeenCalledWith("test-with-dexie")
  })

  it("does not call removePluginTables when retentionMode is 'keep' (default)", async () => {
    const manager = makeTestManager()
    await manager.installPlugin("/tmp/test-with-dexie")
    await manager.enablePlugin("test-with-dexie")
    await manager.uninstallPlugin("test-with-dexie")
    expect(removePluginTables).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test — should fail**

Run: `rtk pnpm test lib/plugin/core/manager.test.ts`

Expected: FAIL

- [ ] **Step 4: Modify `uninstallPlugin`**

In `lib/plugin/core/manager.ts`, inside `uninstallPlugin`, **after** the existing teardown logic but **before** the function returns:

```ts
import { removePluginTables } from "@/lib/plugin/dexie-bridge"
import { getPluginMeta } from "@/lib/plugin/dexie-meta"

// ... inside uninstallPlugin:

const meta = await getPluginMeta(pluginId)
if (meta?.retentionMode === "purge") {
  await removePluginTables(pluginId)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk pnpm test lib/plugin/core/manager.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/plugin/core/manager.ts lib/plugin/core/manager.test.ts
git commit -m "feat(plugin): purge plugin Dexie data on uninstall when retention=purge"
```

---

## Task 14: Settings UI — per-plugin "delete plugin data"

**Files:**

- Create: `components/settings/plugins/plugin-data-management.tsx`
- Test: `components/settings/plugins/plugin-data-management.test.tsx`

Adds a single Card per enabled plugin with a "Delete plugin data on uninstall" toggle and an immediate "Delete data now" button. Component embeds in the per-plugin settings panel; integration into the parent panel is out of scope for M0 (placeholder note added below for future task).

- [ ] **Step 1: Write failing test**

Create `components/settings/plugins/plugin-data-management.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom"
import { PluginDataManagement } from "./plugin-data-management"
import * as meta from "@/lib/plugin/dexie-meta"
import * as bridge from "@/lib/plugin/dexie-bridge"

jest.mock("@/lib/plugin/dexie-meta")
jest.mock("@/lib/plugin/dexie-bridge")

describe("PluginDataManagement", () => {
  beforeEach(() => {
    jest.resetAllMocks()
    ;(meta.getPluginMeta as jest.Mock).mockResolvedValue({
      pluginId: "alpha",
      lastAppliedDexieVersion: 28,
      lastAppliedManifestVersion: 1,
      retentionMode: "keep",
      updatedAt: 0,
    })
  })

  it("renders the retention toggle and reflects current mode", async () => {
    render(<PluginDataManagement pluginId="alpha" />)
    const toggle = await screen.findByRole("switch", { name: /delete plugin data on uninstall/i })
    expect(toggle).not.toBeChecked()
  })

  it("toggling the switch calls setPluginRetentionMode('purge')", async () => {
    render(<PluginDataManagement pluginId="alpha" />)
    const toggle = await screen.findByRole("switch", { name: /delete plugin data on uninstall/i })
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(meta.setPluginRetentionMode).toHaveBeenCalledWith("alpha", "purge")
    })
  })

  it("clicking 'Delete data now' calls removePluginTables after confirmation", async () => {
    window.confirm = jest.fn(() => true)
    render(<PluginDataManagement pluginId="alpha" />)
    const button = await screen.findByRole("button", { name: /delete data now/i })
    fireEvent.click(button)
    await waitFor(() => {
      expect(bridge.removePluginTables).toHaveBeenCalledWith("alpha")
    })
  })

  it("'Delete data now' is a no-op when confirmation is denied", async () => {
    window.confirm = jest.fn(() => false)
    render(<PluginDataManagement pluginId="alpha" />)
    const button = await screen.findByRole("button", { name: /delete data now/i })
    fireEvent.click(button)
    await waitFor(() => {
      expect(bridge.removePluginTables).not.toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run test — should fail**

Run: `rtk pnpm test components/settings/plugins/plugin-data-management.test.tsx`

Expected: FAIL — module not found

- [ ] **Step 3: Implement the component**

Create `components/settings/plugins/plugin-data-management.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { getPluginMeta, setPluginRetentionMode } from "@/lib/plugin/dexie-meta"
import { removePluginTables } from "@/lib/plugin/dexie-bridge"

export interface PluginDataManagementProps {
  pluginId: string
}

export function PluginDataManagement({ pluginId }: PluginDataManagementProps) {
  const [retentionMode, setRetentionMode] = useState<"keep" | "purge">("keep")
  const [isLoading, setIsLoading] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getPluginMeta(pluginId).then((meta) => {
      if (cancelled) return
      setRetentionMode(meta?.retentionMode ?? "keep")
      setIsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [pluginId])

  const onToggle = async (checked: boolean) => {
    const next = checked ? "purge" : "keep"
    setRetentionMode(next)
    try {
      await setPluginRetentionMode(pluginId, next)
    } catch {
      // Revert UI if persistence failed
      setRetentionMode(retentionMode)
    }
  }

  const onDeleteNow = async () => {
    if (!window.confirm(`Delete all data for plugin "${pluginId}"? This cannot be undone.`)) return
    setIsDeleting(true)
    try {
      await removePluginTables(pluginId)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plugin data</CardTitle>
        <CardDescription>
          Manage the IndexedDB tables this plugin owns. Disabling the plugin does not delete data —
          only uninstall (when set below) or "Delete data now" purges it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor={`retention-${pluginId}`} className="cursor-pointer">
            Delete plugin data on uninstall
          </Label>
          <Switch
            id={`retention-${pluginId}`}
            checked={retentionMode === "purge"}
            onCheckedChange={onToggle}
            disabled={isLoading}
            aria-label="Delete plugin data on uninstall"
          />
        </div>
        <Button variant="destructive" onClick={onDeleteNow} disabled={isLoading || isDeleting}>
          {isDeleting ? "Deleting..." : "Delete data now"}
        </Button>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk pnpm test components/settings/plugins/plugin-data-management.test.tsx`

Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add components/settings/plugins/plugin-data-management.tsx components/settings/plugins/plugin-data-management.test.tsx
git commit -m "feat(settings): add per-plugin data management card"
```

---

## Task 15: Integration test — persistence across simulated restart

**Files:**

- Create: `lib/plugin/__tests__/dexie-tables-integration.test.ts`

The earlier unit tests delete the DB between cases. This integration test exercises the "data survives a close+reopen" claim, which is the core promise of the feature.

- [ ] **Step 1: Write the test**

Create `lib/plugin/__tests__/dexie-tables-integration.test.ts`:

```ts
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { applyPluginTables } from "../dexie-bridge"
import { getDb } from "@/lib/db/schema"

describe("Plugin Dexie tables — integration", () => {
  beforeEach(async () => {
    await Dexie.delete("cognia-claude")
  })

  it("data persists across a simulated app restart", async () => {
    // First "session": apply tables and write data
    await applyPluginTables([
      {
        pluginId: "alpha",
        manifestVersion: 1,
        tables: [{ name: "items", schema: "++id, label" }],
      },
    ])
    await getDb().table("alpha:items").put({ id: 1, label: "first" })

    // Simulate restart: close db, drop the singleton, re-create
    getDb().close()
    // The singleton is module-scoped; force reset by re-importing
    jest.resetModules()
    const { getDb: getDb2 } = await import("@/lib/db/schema")
    const { applyPluginTables: apply2 } = await import("../dexie-bridge")

    // Re-apply (idempotent — should be a no-op since meta is persisted)
    await apply2([
      {
        pluginId: "alpha",
        manifestVersion: 1,
        tables: [{ name: "items", schema: "++id, label" }],
      },
    ])
    const row = await getDb2().table("alpha:items").get(1)
    expect(row).toEqual({ id: 1, label: "first" })
  })

  it("two plugins enabled in the same session both work after restart", async () => {
    await applyPluginTables([
      { pluginId: "alpha", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
      { pluginId: "beta", manifestVersion: 1, tables: [{ name: "items", schema: "++id" }] },
    ])
    await getDb().table("alpha:items").put({ id: 1 })
    await getDb().table("beta:items").put({ id: 2 })
    getDb().close()
    jest.resetModules()
    const { getDb: getDb2 } = await import("@/lib/db/schema")
    expect(await getDb2().table("alpha:items").get(1)).toEqual({ id: 1 })
    expect(await getDb2().table("beta:items").get(2)).toEqual({ id: 2 })
  })
})
```

- [ ] **Step 2: Run test**

Run: `rtk pnpm test lib/plugin/__tests__/dexie-tables-integration.test.ts`

Expected: PASS, 2 tests green

If it fails because the singleton survives `jest.resetModules`, the schema module needs an explicit `__resetForTesting()` export. Check for that pattern in `lib/db/schema.ts:897-921`; if absent, add:

```ts
export function __resetForTesting(): void {
  if (typeof window === "undefined") return
  _db?.close()
  _db = null
}
```

Then update the test to call `__resetForTesting()` instead of `jest.resetModules`.

- [ ] **Step 3: Commit**

```bash
git add lib/plugin/__tests__/dexie-tables-integration.test.ts lib/db/schema.ts
git commit -m "test(plugin): integration tests for dexie table persistence"
```

---

## Task 16: Coverage check

**Files:** none (validation step)

- [ ] **Step 1: Run coverage**

Run: `rtk pnpm test:coverage --testPathPattern="lib/plugin/(dexie|api/dexie)"`

Expected: ≥ 90% lines / branches / functions on:

- `lib/plugin/dexie-namespace.ts`
- `lib/plugin/dexie-meta.ts`
- `lib/plugin/dexie-bridge.ts`
- `lib/plugin/dexie-migration-runner.ts`
- `lib/plugin/api/dexie-api.ts`

- [ ] **Step 2: If any file is below threshold, add targeted tests**

For each red row, identify the uncovered line and add a small test in the corresponding `.test.ts`. Re-run coverage. Repeat until green.

- [ ] **Step 3: Commit (only if tests added)**

```bash
git add lib/plugin/**/*.test.ts
git commit -m "test(plugin): backfill coverage for Dexie tables platform feature"
```

---

## Task 17: Documentation

**Files:**

- Create: `docs/content/docs/plugin-dev/dexie-tables.mdx`
- Modify: `docs/content/docs/plugin-dev/meta.json` (if directory exists)

- [ ] **Step 1: Check whether `docs/content/docs/plugin-dev/` exists**

Run: `Glob: "docs/content/docs/plugin-dev/**"`

If it doesn't exist, create the directory first via `New-Item -ItemType Directory -Path "docs/content/docs/plugin-dev"`. Also create a `meta.json` with `{ "title": "Plugin development", "pages": [] }`.

- [ ] **Step 2: Write `dexie-tables.mdx`**

Create `docs/content/docs/plugin-dev/dexie-tables.mdx`:

````mdx
---
title: Plugin Dexie tables
description: Declare per-plugin IndexedDB tables in your manifest and access them via ctx.dexie.
---

## Overview

Plugins can declare their own Dexie tables in `manifest.dexie`. Cognia
namespaces them as `<pluginId>:<tableName>` so two plugins can share a
table name without colliding. Tables are created on plugin enable and
preserved across app restarts. Data is retained on plugin disable;
uninstall behavior depends on a per-plugin retention setting.

## Manifest

```jsonc
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "main": "index.js",
  "dexie": {
    "tables": [
      { "name": "items", "schema": "++id, name" },
      { "name": "events", "schema": "deliveryId, [target+at]" },
    ],
    "migrations": [{ "toVersion": 2, "upgrade": "migrateV1ToV2" }],
  },
}
```

### Table name rules

- Match `^[a-z][a-zA-Z0-9_]{0,30}$`
- Maximum 20 tables per plugin
- Names must be unique within one plugin

### Schema string

Same syntax as Dexie's `db.version().stores({})` values. Examples:

| Schema                      | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `"++id"`                    | Auto-increment integer primary key, no secondary indexes |
| `"++id, name"`              | Same plus a single-field index on `name`                 |
| `"deliveryId, [target+at]"` | Custom string PK plus a compound index                   |
| `"&pluginId, updatedAt"`    | Unique string PK plus a single index                     |

## Accessing tables

Inside your plugin, use `ctx.dexie.table()`:

```ts
import type { PluginContext } from "@cognia/plugin-api"

interface Item {
  id?: number
  name: string
}

export async function activate(ctx: PluginContext) {
  const items = ctx.dexie.table<Item>("items")
  await items.put({ name: "first" })
  const all = await items.toArray()
  ctx.logger.info(`Loaded ${all.length} items`)
}
```

The `pluginId:` prefix is added internally — you reference the logical
name only. Attempting to access an undeclared table throws.

## Migrations

Bump your plugin's `version` field and add an entry to `dexie.migrations`.
On the next enable, Cognia runs each pending migration once, in
ascending `toVersion` order:

```ts
// plugin entry file
export async function migrateV1ToV2() {
  const items = ctx.dexie.table("items")
  await items.toCollection().modify((row) => {
    row.label = row.name // rename in place
    delete row.name
  })
}
```

Migrations cannot fail "halfway" cleanly: if the upgrade callback
throws, the plugin is marked as errored and the migration is retried on
next enable. Make migrations idempotent.

## Data retention on uninstall

By default, your plugin's data is preserved when the user uninstalls
the plugin. Users can opt in to "delete on uninstall" via Settings →
Plugins → (your plugin) → Plugin data. They can also delete
immediately from the same panel.

## Limits

- 20 tables per plugin
- Each plugin enable triggers an IndexedDB schema bump (close → version
  bump → reopen). Multiple plugins enabled in one boot are batched into
  a single bump for efficiency.
````

- [ ] **Step 3: Verify the docs site builds**

Run: `rtk pnpm docs:build` (or `docs:dev` then check the URL `/docs/plugin-dev/dexie-tables`)

Expected: build clean

- [ ] **Step 4: Commit**

```bash
git add docs/content/docs/plugin-dev/
git commit -m "docs(plugin-dev): add dexie-tables guide"
```

---

## Task 18: Update project CLAUDE.md

**Files:**

- Modify: `CLAUDE.md` (add a "Plugin Dexie tables" section in the same body style as "Visual Workflows", "External Bridge", etc.)

- [ ] **Step 1: Locate insertion point**

Use Read on `CLAUDE.md` to find where the existing subsystem sections end (likely after "Visual Workflows" or "Platform Connectors"). Insert before the "Testing Standards" section.

- [ ] **Step 2: Append the section**

Insert into `CLAUDE.md`:

```md
## Plugin Dexie tables

Plugins declare their own IndexedDB tables in `manifest.dexie.tables[]`.
At enable time, `lib/plugin/dexie-bridge.ts:applyPluginTables` aggregates
declarations and bumps the shared `CogniaDB` schema. Tables are
namespaced as `<pluginId>:<tableName>` to prevent collisions; a new
built-in table `pluginDexieMeta` (schema v27) tracks the
last-applied Dexie version and per-plugin data-retention preference.

- **Manifest types** in `types/plugin/plugin.ts`:
  `PluginManifestDexieBlock`, `PluginDexieTableDef`,
  `PluginDexieMigrationDef`.
- **Plugin runtime API**: `ctx.dexie.table<T>(name)` returns a
  `Dexie.Table` namespaced to the calling plugin. Access to undeclared
  tables throws.
- **Lifecycle**: `enablePlugin` calls `applyPluginTables` _before_
  `registerPluginContributions` so contribution code can immediately
  query its tables. Migrations declared in `manifest.dexie.migrations[]`
  run via `lib/plugin/dexie-migration-runner.ts`, once per
  `toVersion`.
- **Uninstall**: data is kept by default. Users can flip
  `retentionMode = "purge"` via Settings → Plugins → Plugin data.
  When set, `uninstallPlugin` calls `removePluginTables`.
- **Limits**: 20 tables per plugin, table-name regex
  `^[a-z][a-zA-Z0-9_]{0,30}$`.

See `docs/content/docs/plugin-dev/dexie-tables.mdx` for the
plugin-author guide.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Plugin Dexie tables platform feature in CLAUDE.md"
```

---

## Task 19: Final verification

**Files:** none

- [ ] **Step 1: Full test run**

Run: `rtk pnpm test`

Expected: green, no flakes

- [ ] **Step 2: Typecheck**

Run: `rtk pnpm typecheck`

Expected: clean

- [ ] **Step 3: Lint**

Run: `rtk pnpm lint`

Expected: clean

- [ ] **Step 4: Build**

Run: `rtk pnpm build`

Expected: clean Next.js export

- [ ] **Step 5: Coverage gate (project-wide)**

Run: `rtk pnpm test:coverage`

Expected: ≥ 90% on all M0 files (verified piecemeal in Task 16; this is the final gate)

- [ ] **Step 6: Manual smoke test in dev mode**

```bash
rtk pnpm dev
```

In a separate browser tab, run in DevTools console:

```js
const Dexie = (await import("dexie")).default
const db = new Dexie("cognia-claude")
await db.open()
console.log(db.tables.map((t) => t.name).filter((n) => n.includes(":")))
// Expect: [] until a plugin with a dexie block is enabled.
// Then enable the test plugin and re-run; expect ["test-plugin:tableName"].
```

- [ ] **Step 7: Push the branch**

```bash
rtk git push -u origin feat/plugin-dexie-tables
```

- [ ] **Step 8: Open PR**

Use the project's `commit-commands:commit-push-pr` skill if available, otherwise:

```bash
rtk gh pr create --title "feat(plugin): plugin-declared Dexie tables (M0)" --body "$(cat <<'EOF'
## Summary
- Plugins can declare IndexedDB tables in `manifest.dexie.tables[]`
- Tables namespaced as `<pluginId>:<tableName>` via `lib/plugin/dexie-bridge.ts`
- Per-plugin data retention setting; default keeps data on uninstall
- Settings UI: per-plugin "Delete plugin data" card
- Docs: `docs/content/docs/plugin-dev/dexie-tables.mdx`

This is M0 of the GitHub Delivery feature (`plans/m0-plugin-dexie-tables.md` in this PR).

## Test plan
- [x] Unit + integration tests, ≥ 90% coverage on new code
- [x] Persistence across simulated app restart
- [x] Two-plugin namespace isolation
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build` all clean
- [ ] Reviewer: confirm no schema migration breaks existing data on dev IndexedDB
EOF
)"
```

---

## Self-Review Checklist (run after writing all tasks above)

**1. Spec coverage:** Walk through each line of the M0 row in `plans/github-fuzzy-unicorn.md` section 14:

- "manifest 块" → Task 1 ✓
- "dexie-bridge" → Tasks 6, 7, 8 ✓
- "ctx API" → Tasks 10, 11 ✓
- "DexieDevTools 显示前缀" → handled implicitly by namespacing (Tasks 2, 6); no explicit DevTools work needed because Dexie inspector lists all tables natively ✓
- "docs" → Task 17 ✓
- Exit standard 1 ("两个测试插件能各声明同名表互不干扰") → Task 7 ✓
- Exit standard 2 ("卸载/重启数据保留") → Tasks 13, 15 ✓
- Exit standard 3 ("migration 跑且仅一次") → Task 9 ✓

Plus added tasks not in original spec but needed:

- Validation (Task 3) — required because manifest validation is a hard requirement of the plugin system
- Static schema v27 (Task 4) — needed because `pluginDexieMeta` itself must exist before any dynamic version applies
- Settings UI (Task 14) — needed because retention toggle has no surface otherwise

**2. Placeholder scan:** No "TBD", "implement later", or "fill in details" anywhere. All code blocks are complete.

**3. Type consistency:**

- `PluginTablesInput` defined in Task 6, used consistently in Tasks 6, 7, 8, 12, 15 ✓
- `applyPluginTables` signature: `(inputs: PluginTablesInput[]) => Promise<void>` everywhere ✓
- `removePluginTables` signature: `(pluginId: string) => Promise<void>` everywhere ✓
- `recordPluginApply` signature: `(pluginId, { dexieVersion, manifestVersion })` consistent across Tasks 5, 6, 9 ✓
- `PluginDexieAPI.table<T>(name): Dexie.Table<T, unknown>` consistent ✓

**4. Order dependencies:**

- Task 0 (investigate) before Task 10 (which needs the decision) ✓
- Task 4 (static schema v27) before Task 5 (which queries `pluginDexieMeta`) ✓
- Task 6 (applyPluginTables) before Task 12 (which calls it from manager) ✓
- Task 8 (removePluginTables) before Task 13 (which calls it from manager) ✓
- Task 11 (wire ctx.dexie) before Task 14 (UI uses meta + bridge, not ctx, so independent — OK) ✓

---

## Execution Handoff

Plan complete and saved to `plans/m0-plugin-dexie-tables.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

Which approach?
