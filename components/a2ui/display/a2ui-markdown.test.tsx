import React from "react"
import { render, screen } from "@testing-library/react"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UIMarkdownComponent } from "@/types/artifact/a2ui"

const dataModel: Record<string, unknown> = { page: { body: "# From the data model" } }

jest.mock("../a2ui-context", () => ({
  useA2UIData: () => ({
    resolveString: (value: unknown, fallback = "") => {
      if (typeof value === "string") return value
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { path?: string }).path === "string"
      ) {
        const segments = (value as { path: string }).path.replace(/^\//, "").split("/")
        let cursor: unknown = dataModel
        for (const segment of segments) {
          if (!cursor || typeof cursor !== "object") return fallback
          cursor = (cursor as Record<string, unknown>)[segment]
        }
        return typeof cursor === "string" ? cursor : fallback
      }
      return fallback
    },
  }),
}))

// The wrapper's whole job is to hand the chat renderer the right props, so the
// renderer is stubbed and the props are the assertion. Rendering the real
// react-markdown pipeline here would test that dependency, not this file.
const rendererProps: Array<Record<string, unknown>> = []
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: (props: Record<string, unknown>) => {
    rendererProps.push(props)
    return <div data-testid="markdown">{String(props.content)}</div>
  },
}))

import { A2UIMarkdown } from "./a2ui-markdown"

function props(
  component: A2UIMarkdownComponent,
  onAction = jest.fn()
): A2UIComponentProps<A2UIMarkdownComponent> {
  return {
    component,
    surfaceId: "surface",
    dataModel,
    onAction,
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  }
}

describe("A2UIMarkdown", () => {
  beforeEach(() => {
    rendererProps.length = 0
  })

  it("renders inline content through the chat markdown pipeline", () => {
    render(<A2UIMarkdown {...props({ id: "md", component: "Markdown", content: "# Hello" })} />)
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Hello")
  })

  it("resolves a data-model path so a plugin can stream a page into the surface", () => {
    render(
      <A2UIMarkdown
        {...props({ id: "md", component: "Markdown", content: { path: "/page/body" } })}
      />
    )
    expect(screen.getByTestId("markdown")).toHaveTextContent("# From the data model")
  })

  it("defaults to article rhythm, not the chat turn's tightened flow", () => {
    render(<A2UIMarkdown {...props({ id: "md", component: "Markdown", content: "x" })} />)
    expect(rendererProps[0]).toMatchObject({ rhythm: "document" })
  })

  it("keeps mermaid, math and code affordances on unless the plugin opts out", () => {
    render(<A2UIMarkdown {...props({ id: "md", component: "Markdown", content: "x" })} />)
    expect(rendererProps[0]).toMatchObject({
      enableMermaid: true,
      enableMath: true,
      showLineNumbers: true,
      wrapLines: false,
    })

    rendererProps.length = 0
    render(
      <A2UIMarkdown
        {...props({
          id: "md",
          component: "Markdown",
          content: "x",
          mermaid: false,
          math: false,
          codeLineNumbers: false,
          codeWrap: true,
          rhythm: "chat",
        })}
      />
    )
    expect(rendererProps[0]).toMatchObject({
      enableMermaid: false,
      enableMath: false,
      showLineNumbers: false,
      wrapLines: true,
      rhythm: "chat",
    })
  })

  it("leaves file links to the host until the plugin claims them", () => {
    render(<A2UIMarkdown {...props({ id: "md", component: "Markdown", content: "x" })} />)
    // Undefined, not a no-op closure: the renderer branches on presence to
    // decide whether the host opens the file itself.
    expect(rendererProps[0].onOpenProjectFile).toBeUndefined()
  })

  it("routes a claimed file link to the plugin's action instead of opening it", () => {
    const onAction = jest.fn()
    render(
      <A2UIMarkdown
        {...props(
          { id: "md", component: "Markdown", content: "x", openFileAction: "open-citation" },
          onAction
        )}
      />
    )
    const handler = rendererProps[0].onOpenProjectFile as (target: {
      absolutePath: string
      line?: number
      column?: number
    }) => void
    handler({ absolutePath: "/repo/src/main.ts", line: 42 })
    expect(onAction).toHaveBeenCalledWith("open-citation", {
      path: "/repo/src/main.ts",
      line: 42,
    })
  })

  it("omits an absent line rather than sending an undefined one", () => {
    const onAction = jest.fn()
    render(
      <A2UIMarkdown
        {...props(
          { id: "md", component: "Markdown", content: "x", openFileAction: "open-citation" },
          onAction
        )}
      />
    )
    const handler = rendererProps[0].onOpenProjectFile as (target: { absolutePath: string }) => void
    handler({ absolutePath: "/repo/README.md" })
    expect(onAction).toHaveBeenCalledWith("open-citation", { path: "/repo/README.md" })
  })
})
