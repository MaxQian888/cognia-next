import { fireEvent, render, screen } from "@testing-library/react"

import {
  composeTurnText,
  type PromptPreambleReference,
  type PromptPreambleSectionKind,
} from "@/lib/chat/prompt-preamble"
import { PromptPreambleCard } from "./prompt-preamble-card"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const { preamble } = composeTurnText(
  "compare",
  [
    { kind: "references", text: "Referenced context:\n\nSECRET BODY" },
    { kind: "webSearch", text: "web results" },
  ],
  { nonce: "abcdef0123" }
)

describe("PromptPreambleCard", () => {
  it("folds the envelope into one line that counts the references", () => {
    render(
      <PromptPreambleCard
        preamble={preamble}
        summary={{
          sections: ["references", "webSearch"],
          references: [
            { kind: "entity", entityKind: "issue", title: "COG-1", href: "/issues?id=1" },
            { kind: "file", title: "src/a.ts" },
          ],
        }}
      />
    )
    expect(screen.getByTestId("prompt-preamble-toggle")).toHaveTextContent(
      'chat.promptPreamble.references:{"count":2}'
    )
    expect(screen.getByTestId("prompt-preamble-section-webSearch")).toBeInTheDocument()
    // Nothing of the body is printed until the user asks for it.
    expect(screen.queryByText(/SECRET BODY/)).toBeNull()
    expect(screen.queryByTestId("prompt-preamble-reference")).toBeNull()
  })

  it("lists the references, linking in-app records, and reveals the exact text on request", () => {
    render(
      <PromptPreambleCard
        preamble={preamble}
        summary={{
          sections: ["references"],
          references: [
            { kind: "entity", entityKind: "issue", title: "COG-1", href: "/issues?id=1" },
            { kind: "web", title: "Docs", href: "https://example.com/docs" },
            {
              kind: "entity",
              entityKind: "message",
              title: "Restacking",
              href: "/?session=s&message=m",
              count: 3,
            },
          ],
        }}
      />
    )
    fireEvent.click(screen.getByTestId("prompt-preamble-toggle"))
    const rows = screen.getAllByTestId("prompt-preamble-reference")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAttribute("href", "/issues?id=1")
    expect(rows[0]).toHaveTextContent("chat.composer.popover.entityKinds.issue")
    expect(rows[1]).toHaveAttribute("target", "_blank")
    expect(rows[2]).toHaveTextContent(
      'chat.promptPreamble.combinedTitle:{"title":"Restacking","count":3}'
    )

    fireEvent.click(screen.getByTestId("prompt-preamble-text-toggle"))
    const text = screen.getByTestId("prompt-preamble-text")
    expect(text).toHaveTextContent("SECRET BODY")
    // The envelope's tags and framing are the app's, not something to show.
    expect(text.textContent).not.toContain("cognia_context_")
  })

  // A legacy row, or one a Host persisted from content alone, has no summary.
  it("falls back to a generic line when nothing was itemised", () => {
    render(<PromptPreambleCard preamble={preamble} summary={null} />)
    expect(screen.getByTestId("prompt-preamble-toggle")).toHaveTextContent(
      "chat.promptPreamble.generic"
    )
    fireEvent.click(screen.getByTestId("prompt-preamble-toggle"))
    expect(screen.queryByTestId("prompt-preamble-reference")).toBeNull()
    expect(screen.getByTestId("prompt-preamble-text-toggle")).toBeInTheDocument()
  })

  it("names non-entity kinds with its own nouns", () => {
    render(
      <PromptPreambleCard
        preamble={preamble}
        summary={{ sections: ["references"], references: [{ kind: "artifact", title: "Hero" }] }}
      />
    )
    fireEvent.click(screen.getByTestId("prompt-preamble-toggle"))
    expect(screen.getByTestId("prompt-preamble-reference")).toHaveTextContent(
      "chat.promptPreamble.kinds.artifact"
    )
  })
})

// The kind and section labels are looked up by dynamic key, so lint:i18n
// cannot see them. Pin the catalogue against every value the types allow.
describe("message catalogue coverage", () => {
  const catalogues = {
    en: jest.requireActual("@/i18n/messages/en/chat.json"),
    "zh-CN": jest.requireActual("@/i18n/messages/zh-CN/chat.json"),
  } as const
  const selectionKinds: Array<PromptPreambleReference["kind"]> = [
    "artifact",
    "file",
    "comment",
    "web",
    "external",
    "plugin",
    "entity",
  ]
  const extraSections: PromptPreambleSectionKind[] = ["webSearch", "reviewReceipts"]

  it.each(Object.entries(catalogues))("%s names every kind and section", (_locale, chat) => {
    for (const kind of selectionKinds) {
      expect(typeof chat.promptPreamble.kinds[kind]).toBe("string")
    }
    for (const section of extraSections) {
      expect(typeof chat.promptPreamble.sections[section]).toBe("string")
    }
    for (const key of ["generic", "references", "combinedTitle", "showText", "hideText"]) {
      expect(typeof chat.promptPreamble[key]).toBe("string")
    }
  })
})
