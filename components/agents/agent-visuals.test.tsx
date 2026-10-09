/** @jest-environment jsdom */

// The agents console's visual vocabulary (ADR-0220): avatar and live dot,
// status word, runtime label and source badges.

import { render, screen } from "@testing-library/react"

import type { Character, CharacterRuntimeBinding } from "@cognia/agent-config-types"

let mockRuntimes: Array<{ key: string; name: string }> = []
jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({
  useAgentRuntimeCatalog: () => ({ runtimes: mockRuntimes }),
}))

import type { AgentSource } from "@/lib/agents/agent-source"
import {
  AgentAvatar,
  AgentRuntimeLabel,
  AgentSourceBadges,
  AgentStatusDot,
  AgentStatusLabel,
} from "./agent-visuals"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

function source(over: Partial<AgentSource> = {}): AgentSource {
  return {
    isOverlay: false,
    isCloned: false,
    fromLocalFile: false,
    updateAvailable: false,
    warnings: [],
    editable: true,
    deletable: true,
    ...over,
  }
}

beforeEach(() => {
  mockRuntimes = []
})

describe("AgentStatusDot", () => {
  it.each([
    ["running", "bg-emerald-500"],
    ["awaiting", "bg-amber-500"],
    ["idle", "bg-muted-foreground/40"],
  ] as const)("paints %s with %s and hides itself from assistive tech", (status, cls) => {
    const { container } = render(<AgentStatusDot status={status} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot).toHaveAttribute("aria-hidden", "true")
    expect(dot.className).toContain(cls)
  })

  it("pulses only while running", () => {
    const { container, rerender } = render(<AgentStatusDot status="running" />)
    expect((container.firstElementChild as HTMLElement).className).toContain("animate-pulse")
    rerender(<AgentStatusDot status="awaiting" />)
    expect((container.firstElementChild as HTMLElement).className).not.toContain("animate-pulse")
  })

  it("merges a caller class", () => {
    const { container } = render(<AgentStatusDot status="idle" className="custom-dot" />)
    expect((container.firstElementChild as HTMLElement).className).toContain("custom-dot")
  })
})

describe("AgentAvatar", () => {
  it("draws the emoji at the requested size", () => {
    const { container } = render(<AgentAvatar agent={agent({ avatarEmoji: "🦊" })} size={48} />)
    const badge = container.firstElementChild as HTMLElement
    expect(badge).toHaveTextContent("🦊")
    expect(badge.style.width).toBe("48px")
    expect(badge.style.height).toBe("48px")
  })

  it("uses the larger glyph size from 40px up and the smaller below", () => {
    const { container, rerender } = render(<AgentAvatar agent={agent()} size={40} />)
    expect((container.firstElementChild as HTMLElement).className).toContain("text-lg")
    rerender(<AgentAvatar agent={agent()} size={36} />)
    expect((container.firstElementChild as HTMLElement).className).toContain("text-sm")
  })

  it("defaults to 32px", () => {
    const { container } = render(<AgentAvatar agent={agent()} />)
    expect((container.firstElementChild as HTMLElement).style.width).toBe("32px")
  })

  it("shows the picture when the agent has one", () => {
    const { container } = render(
      <AgentAvatar
        agent={agent({
          avatarImage: { webDataUrl: "data:image/png;base64,AAAA" } as Character["avatarImage"],
        })}
      />
    )
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA")
  })

  it.each(["running", "awaiting"] as const)("adds a %s dot", (status) => {
    const { container } = render(<AgentAvatar agent={agent()} status={status} />)
    const dot = container.querySelector(".ring-background")
    expect(dot).toBeInTheDocument()
    expect(dot?.className).toContain(status === "running" ? "bg-emerald-500" : "bg-amber-500")
  })

  it("adds no dot when idle or when no status is given", () => {
    const { container, rerender } = render(<AgentAvatar agent={agent()} status="idle" />)
    expect(container.querySelector(".ring-background")).not.toBeInTheDocument()
    rerender(<AgentAvatar agent={agent()} />)
    expect(container.querySelector(".ring-background")).not.toBeInTheDocument()
  })
})

describe("AgentStatusLabel", () => {
  it.each([
    ["running", "Running", "text-emerald-600"],
    ["awaiting", "Needs approval", "text-amber-600"],
    ["idle", "Idle", "text-muted-foreground"],
  ] as const)("says %s as %s", (status, word, cls) => {
    render(<AgentStatusLabel status={status} />)
    const label = screen.getByTestId("agent-status")
    expect(label).toHaveTextContent(word)
    expect(label).toHaveAttribute("data-status", status)
    expect(label.className).toContain(cls)
  })
})

describe("AgentRuntimeLabel", () => {
  it("says app default when the agent names no runtime", () => {
    render(<AgentRuntimeLabel runtime={undefined} />)
    expect(screen.getByText("App default")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-runtime-label")).not.toBeInTheDocument()
  })

  it("names the built-in lane", () => {
    render(<AgentRuntimeLabel runtime={{ kind: "builtin" }} />)
    expect(screen.getByText("Cognia Agent")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-runtime-label")).not.toBeInTheDocument()
  })

  it("shows an available external agent by the catalog's name", () => {
    mockRuntimes = [{ key: "external:codex", name: "Codex CLI" }]
    render(<AgentRuntimeLabel runtime={{ kind: "external", agentId: "codex", name: "stale" }} />)
    const label = screen.getByTestId("agent-runtime-label")
    expect(label).toHaveTextContent("Codex CLI")
    expect(label).toHaveAttribute("data-available", "true")
    expect(label).toHaveAttribute("title", "Codex CLI")
    expect(label.className).not.toContain("text-destructive")
  })

  it("shows an available host runtime by the catalog's name", () => {
    mockRuntimes = [{ key: "host:cfg1", name: "Build box" }]
    render(<AgentRuntimeLabel runtime={{ kind: "host", configId: "cfg1" }} />)
    expect(screen.getByTestId("agent-runtime-label")).toHaveTextContent("Build box")
  })

  it("marks an external agent missing from this device as unavailable, using its cached name", () => {
    render(<AgentRuntimeLabel runtime={{ kind: "external", agentId: "codex", name: "Codex" }} />)
    const label = screen.getByTestId("agent-runtime-label")
    expect(label).toHaveTextContent("Codex (unavailable)")
    expect(label).toHaveAttribute("data-available", "false")
    expect(label).toHaveAttribute("title", "Codex (unavailable)")
    expect(label.className).toContain("text-destructive")
  })

  it.each<[CharacterRuntimeBinding, string]>([
    [{ kind: "external", agentId: "codex" }, "codex (unavailable)"],
    [{ kind: "host", configId: "cfg9" }, "cfg9 (unavailable)"],
  ])("falls back to the id when an unavailable runtime has no cached name: %j", (runtime, text) => {
    render(<AgentRuntimeLabel runtime={runtime} />)
    expect(screen.getByTestId("agent-runtime-label")).toHaveTextContent(text)
  })

  it("passes a caller class through on every variant", () => {
    const { container, rerender } = render(
      <AgentRuntimeLabel runtime={undefined} className="x-1" />
    )
    expect((container.firstElementChild as HTMLElement).className).toContain("x-1")
    rerender(<AgentRuntimeLabel runtime={{ kind: "builtin" }} className="x-2" />)
    expect((container.firstElementChild as HTMLElement).className).toContain("x-2")
    rerender(<AgentRuntimeLabel runtime={{ kind: "host", configId: "c" }} className="x-3" />)
    expect((container.firstElementChild as HTMLElement).className).toContain("x-3")
  })
})

describe("AgentSourceBadges", () => {
  it("renders nothing for a plain user agent", () => {
    const { container } = render(<AgentSourceBadges agent={agent()} source={source()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("marks a built-in agent", () => {
    render(<AgentSourceBadges agent={agent({ isBuiltIn: true })} source={source()} />)
    expect(screen.getByText("Built-in")).toBeInTheDocument()
  })

  it("names the base of a variant and counts its overrides in the tooltip", () => {
    render(
      <AgentSourceBadges
        agent={agent({
          variant: { baseId: "base_1", ownFields: ["name", "model"] } as Character["variant"],
        })}
        source={source()}
        baseName="Planner"
      />
    )
    const badge = screen.getByText("Variant of Planner")
    expect(badge).toHaveAttribute("title", "Overrides 2 fields; follows its base for the rest")
  })

  it("falls back to the base id when the base's name is unknown", () => {
    render(
      <AgentSourceBadges
        agent={agent({ variant: { baseId: "base_1", ownFields: [] } as Character["variant"] })}
        source={source()}
      />
    )
    expect(screen.getByText("Variant of base_1")).toHaveAttribute(
      "title",
      "Follows its base for everything"
    )
  })

  it("flags a pack update", () => {
    render(<AgentSourceBadges agent={agent()} source={source({ updateAvailable: true })} />)
    expect(screen.getByText("Update available")).toBeInTheDocument()
  })

  it("counts missing dependencies and lists them in the tooltip", () => {
    render(
      <AgentSourceBadges
        agent={agent()}
        source={source({
          warnings: [
            { code: "missing-skill", missingId: "web-search" },
            { code: "missing-provider", missingId: "acme", characterLocalId: "helper" },
          ],
        })}
      />
    )
    const badge = screen.getByText("Missing deps (2)")
    expect(badge.getAttribute("title")).toBe(
      "Missing skill: web-search\nMissing provider: acme (character: helper)"
    )
  })

  it("uses the singular for one missing dependency", () => {
    render(
      <AgentSourceBadges
        agent={agent()}
        source={source({ warnings: [{ code: "missing-skill", missingId: "s" }] })}
      />
    )
    expect(screen.getByText("Missing dep")).toBeInTheDocument()
  })

  it("draws no origin badge: where an agent came from is a fact on the profile, not a warning", () => {
    render(
      <AgentSourceBadges
        agent={agent({ sourcePluginId: "plug", sourcePackId: "pack" })}
        source={source({ isCloned: true, sourcePluginId: "plug", packId: "pack" })}
      />
    )
    expect(screen.queryByText(/Cloned from/)).not.toBeInTheDocument()
    expect(screen.queryByText(/From /)).not.toBeInTheDocument()
  })

  it("stacks every badge that applies", () => {
    render(
      <AgentSourceBadges
        agent={agent({
          isBuiltIn: true,
          variant: { baseId: "b", ownFields: [] } as Character["variant"],
        })}
        source={source({
          updateAvailable: true,
          warnings: [{ code: "missing-skill", missingId: "s" }],
        })}
        baseName="Base"
      />
    )
    for (const text of ["Built-in", "Variant of Base", "Update available", "Missing dep"]) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
  })
})
