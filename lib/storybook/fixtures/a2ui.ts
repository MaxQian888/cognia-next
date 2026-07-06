// Shared fixture for A2UI component stories. Every A2UI renderer takes the same
// `A2UIComponentProps` envelope (component descriptor + surface plumbing); this
// builder supplies inert defaults so a story only has to describe the component.
// Callbacks default to no-ops — pass `fn()` from "storybook/test" via `over` when
// a story needs to assert on interactions.
import type { A2UIComponent, A2UIComponentProps, A2UISurfaceState } from "@/types/a2ui/schema"
import type { A2UIHistoryEntry } from "@/stores/a2ui/a2ui-store"
import type { A2UIAppInstance } from "@/hooks/a2ui/app-builder/types"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"
import type { Paper } from "@/types/academic"

export function makeA2UIProps<T extends A2UIComponent>(
  component: T,
  over: Partial<A2UIComponentProps<T>> = {}
): A2UIComponentProps<T> {
  return {
    component,
    surfaceId: "story-surface",
    dataModel: {},
    onAction: () => {},
    onDataChange: () => {},
    renderChild: () => null,
    ...over,
  }
}

// A small, valid component tree (Card → heading + body + button) used to seed
// the A2UI store so surface / renderer / workspace stories render real UI.
export function makeSurfaceState(over: Partial<A2UISurfaceState> = {}): A2UISurfaceState {
  return {
    id: "story-surface",
    type: "inline",
    ready: true,
    rootId: "root",
    catalogId: "default",
    title: "Sample widget",
    components: {
      root: {
        id: "root",
        component: "Card",
        title: "Sample widget",
        children: ["heading", "body", "cta"],
      },
      heading: { id: "heading", component: "Text", text: "Hello from A2UI", variant: "heading3" },
      body: {
        id: "body",
        component: "Text",
        text: "This surface was seeded for Storybook.",
      },
      cta: { id: "cta", component: "Button", text: "Run action", action: "run" },
    },
    dataModel: { greeting: "hello", count: 3, enabled: true },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

// The "simplified" A2UI payload shape the parser accepts as tool output / message
// content. Renders to a single Text inside a Card on the given surface id.
export function makeSimplifiedSpec(surfaceId = "tool-demo") {
  return {
    surface: { id: surfaceId, type: "inline" as const, title: "Tool result" },
    components: [
      { id: "root", component: "Card", title: "Tool result", children: ["text"] },
      { id: "text", component: "Text", text: "Rendered from tool output." },
    ],
    dataModel: {},
  }
}

export function makeHistoryEntry(over: Partial<A2UIHistoryEntry> = {}): A2UIHistoryEntry {
  return {
    id: "entry-1",
    timestamp: Date.now(),
    description: "Edit component",
    components: {},
    dataModel: {},
    ...over,
  }
}

export function makeAppInstance(over: Partial<A2UIAppInstance> = {}): A2UIAppInstance {
  return {
    id: "app-1",
    templateId: "calculator",
    name: "Budget Calculator",
    createdAt: Date.now() - 86_400_000,
    lastModified: Date.now() - 3_600_000,
    description: "A quick calculator built with A2UI.",
    version: "1.2.0",
    category: "utility",
    tags: ["finance", "tools", "math"],
    author: { name: "Ada Lovelace", email: "ada@example.com" },
    stats: { views: 128, uses: 42, rating: 4.5, ratingCount: 18 },
    ...over,
  }
}

export function makeAppTemplate(over: Partial<A2UIAppTemplate> = {}): A2UIAppTemplate {
  return {
    id: "calculator",
    name: "Calculator",
    description: "Basic arithmetic calculator template.",
    icon: "Calculator",
    category: "utility",
    components: [{ id: "root", component: "Column", children: [] }],
    dataModel: {},
    tags: ["math", "tools"],
    ...over,
  }
}

export function makePaper(over: Partial<Paper> = {}): Paper {
  return {
    id: "paper-1",
    providerId: "arxiv",
    externalId: "2301.00001",
    title: "Attention Is All You Need: A Storybook Fixture",
    abstract:
      "We introduce a sample paper used to render the academic A2UI components in isolation.",
    authors: [{ name: "Jane Researcher" }, { name: "John Scholar" }, { name: "Sam Scientist" }],
    year: 2023,
    venue: "NeurIPS",
    citationCount: 1240,
    isOpenAccess: true,
    pdfUrl: "https://example.com/paper.pdf",
    urls: [{ url: "https://example.com/paper.pdf", type: "pdf", source: "arxiv" }],
    metadata: { arxivId: "2301.00001" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    fetchedAt: new Date(0),
    ...over,
  }
}
