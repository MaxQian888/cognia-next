/**
 * Gate: the Context Workbench taxonomy must not grow entries nothing can reach.
 *
 * Two different invariants, because capabilities and activities are consumed in
 * genuinely different ways — conflating them produces false alarms:
 *
 *  - **Capabilities** are a purely plugin-facing gate. No first-party panel
 *    declares `requiredCapabilities` (they use `appliesTo` predicates, which can
 *    express more), so "no first-party consumer" is normal and proves nothing.
 *    What matters is that `resolveContextCapabilities` actually PRODUCES each
 *    one for some resource — a capability it never emits is one a plugin can
 *    declare and then never appear for anything.
 *
 *  - **Activities** are consumed first-party: every built-in panel declares one.
 *    An activity with no built-in panel is a rail group only a plugin can fill,
 *    which is legitimate but must be deliberate — hence the explicit list.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  CANONICAL_CONTEXT_ACTIVITIES,
  INTENTIONALLY_UNCONSUMED_CONTEXT_ACTIVITIES,
  type ContextCapability,
} from "@/types/context-workbench"
import { resolveContextCapabilities } from "./capabilities"

/** Every capability `resolveContextCapabilities` can emit, across all inputs. */
function producibleCapabilities(): Set<ContextCapability> {
  const produced = new Set<ContextCapability>()
  const inputs = [
    { kind: "session", workspaceAvailable: true },
    { kind: "session", workspaceAvailable: false },
    { kind: "project-file", previewable: true },
    { kind: "project-file", previewable: false },
    { kind: "canvas-document", runnable: true },
    { kind: "canvas-document", runnable: false },
    { kind: "artifact", previewable: true, runnable: true, workspaceAvailable: true },
    { kind: "artifact", previewable: false, runnable: false, workspaceAvailable: false },
    { kind: "workflow" },
  ] as const
  for (const input of inputs) {
    for (const capability of resolveContextCapabilities(input)) produced.add(capability)
  }
  return produced
}

/**
 * The activities first-party panels declare. Scraped from source rather than
 * imported: the panel lists live inside React components that would need the
 * whole dock tree mocked to evaluate, and the declarations are plain literals.
 */
function firstPartyActivities(): Set<string> {
  const sources = [
    // The chat dock's own definitions live beside it, not in the host — it is
    // the only first-party source that claims `workspace`, so leaving it out
    // reported that activity as orphaned.
    "components/artifacts/chat-dock-panels.tsx",
    "components/canvas/canvas-side-panels.tsx",
    "components/editor/project/project-context-workbench.tsx",
    "components/workflow/editor/right-sidebar/index.tsx",
  ]
  const found = new Set<string>()
  for (const relative of sources) {
    const source = readFileSync(join(process.cwd(), relative), "utf8")
    for (const match of source.matchAll(/^\s*activity: "([a-z-]+)"/gm)) found.add(match[1])
  }
  // Guard the scraper: if these files are ever restructured so the literals no
  // longer match, fail loudly instead of reporting every activity as orphaned.
  expect(found.size).toBeGreaterThan(3)
  return found
}

describe("context capabilities", () => {
  it("produces every capability the type allows", () => {
    // A capability the resolver never emits is undeclarable in practice: a
    // plugin panel gating on it would be filtered out for every resource.
    const produced = producibleCapabilities()
    const canonical: ContextCapability[] = [
      "ai",
      "comments",
      "inspect",
      "review",
      "preview",
      "run",
      "templates",
      "workspace",
      "history",
    ]

    expect(canonical.filter((capability) => !produced.has(capability))).toEqual([])
  })

  it("emits nothing outside the declared union", () => {
    const canonical = new Set([
      "ai",
      "comments",
      "inspect",
      "review",
      "preview",
      "run",
      "templates",
      "workspace",
      "history",
    ])

    expect([...producibleCapabilities()].filter((c) => !canonical.has(c))).toEqual([])
  })
})

describe("context activities", () => {
  it("backs every canonical activity with a first-party panel, or declares it reserved", () => {
    const builtIn = firstPartyActivities()
    const reserved = new Set<string>(INTENTIONALLY_UNCONSUMED_CONTEXT_ACTIVITIES)

    const orphaned = CANONICAL_CONTEXT_ACTIVITIES.filter(
      (activity) => !builtIn.has(activity) && !reserved.has(activity)
    )

    expect(orphaned).toEqual([])
  })

  it("does not reserve an activity that first-party panels actually use", () => {
    // The reverse drift: once a built-in panel claims a reserved activity, the
    // list is stale and misdescribes the taxonomy.
    const builtIn = firstPartyActivities()

    expect(INTENTIONALLY_UNCONSUMED_CONTEXT_ACTIVITIES.filter((a) => builtIn.has(a))).toEqual([])
  })

  it("keeps first-party panels inside the canonical activity set", () => {
    const canonical = new Set<string>(CANONICAL_CONTEXT_ACTIVITIES)

    expect([...firstPartyActivities()].filter((a) => !canonical.has(a))).toEqual([])
  })
})
