import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { lazy, type ComponentType } from "react"
import { ChatLink } from "./chat-link"
import { ChatLinkOptionsProvider } from "./chat-link-options"
import { DEFAULT_MESSAGE_LINK_OPTIONS } from "@/lib/chat/message-display"
import {
  clearAllLinkMatchers,
  clearLinkMatchersForPlugin,
  registerLinkMatcher,
} from "@/lib/plugin/api/link-matchers"
import type { LinkMatcherProps } from "@/types/plugin/plugin-link-matcher"
import { chatMarkdownUrlTransform } from "./rendering-policy"

jest.mock("@/components/chat/project-file-link", () => ({
  ProjectFileLink: ({
    children,
    onOpenFile,
    target,
  }: {
    children: React.ReactNode
    onOpenFile?: (target: unknown) => void
    target: unknown
  }) => <button onClick={() => onOpenFile?.(target)}>{children}</button>,
}))
jest.mock("@/lib/plugin/analytics/record", () => ({
  recordPluginAnalytic: jest.fn(),
  PLUGIN_ANALYTIC_KEYS: { surfaceError: "surface.error" },
}))
jest.mock("@/lib/plugin/utils/analytics", () => ({ trackPluginEvent: jest.fn() }))
jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordPluginPointDiagnostic: jest.fn(),
}))

function PluginLink({ href, children, messageId, isStreaming }: LinkMatcherProps) {
  return (
    <a
      href={href}
      data-message-id={messageId}
      data-streaming={String(isStreaming)}
      data-plugin-link
    >
      {children}
    </a>
  )
}
function register(component: ComponentType<LinkMatcherProps> = PluginLink, priority = 0) {
  return registerLinkMatcher("link-test", {
    id: "reference",
    patterns: ["example.com/**"],
    component,
    priority,
  })
}

afterEach(() => act(() => clearAllLinkMatchers()))

describe("ChatLink", () => {
  it.each(["javascript:alert(1)", "cognia://plugin/test", "data:text/html,test"])(
    "does not offer a stripped %s URL to plugins",
    (url) => {
      const component = jest.fn(PluginLink)
      register(component)
      const href = chatMarkdownUrlTransform(url, "href")
      render(<ChatLink href={href}>Stripped</ChatLink>)
      expect(href).toBe("")
      expect(screen.getByText("Stripped")).toHaveAttribute("href", "")
      expect(component).not.toHaveBeenCalled()
    }
  )

  it("recovers a crashed matcher after a batched hot re-registration", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const unregister = register(() => {
      throw new Error("plugin failed")
    })
    render(<ChatLink href="https://example.com/pr/1">Review</ChatLink>)
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank")
    act(() => {
      unregister()
      register()
    })
    expect(screen.getByRole("link")).toHaveAttribute("data-plugin-link")
    errorSpy.mockRestore()
  })

  it("updates existing links when plugins register, unregister, and disable", () => {
    render(
      <p>
        <ChatLink href="https://example.com/pr/1" messageId="message-1" isStreaming>
          Review
        </ChatLink>
      </p>
    )
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank")
    let unregister = () => {}
    act(() => {
      unregister = register()
    })
    expect(screen.getByRole("link")).toHaveAttribute("data-message-id", "message-1")
    expect(screen.getByRole("link")).toHaveAttribute("data-streaming", "true")
    expect(screen.getByRole("link").parentElement?.tagName).toBe("SPAN")
    expect(screen.getByRole("link").closest("p")?.querySelector("div")).toBeNull()
    act(unregister)
    expect(screen.getByRole("link")).not.toHaveAttribute("data-plugin-link")
    act(() => {
      register()
    })
    act(() => clearLinkMatchersForPlugin("link-test"))
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank")
  })

  it("keeps project-file handling and its owner callback ahead of plugins", () => {
    const plugin = jest.fn(PluginLink)
    registerLinkMatcher("host-priority", {
      id: "all",
      patterns: ["example.com/**"],
      component: plugin,
    })
    const onOpenProjectFile = jest.fn()
    render(
      <ChatLink
        href="/workspace/readme.md"
        projectRoot="/workspace"
        onOpenProjectFile={onOpenProjectFile}
      >
        readme
      </ChatLink>
    )
    fireEvent.click(screen.getByRole("button", { name: "readme" }))
    expect(onOpenProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: "/workspace/readme.md" })
    )
    expect(plugin).not.toHaveBeenCalled()
  })

  it("preserves native external link attributes and empty sanitized hrefs", () => {
    register()
    const { rerender } = render(
      <ChatLink href="mailto:hello@example.com" title="Email">
        Email
      </ChatLink>
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "mailto:hello@example.com")
    expect(screen.getByRole("link")).toHaveAttribute("title", "Email")
    rerender(<ChatLink>Stripped</ChatLink>)
    expect(screen.getByText("Stripped")).toHaveAttribute("href", "")
    expect(screen.getByText("Stripped")).not.toHaveAttribute("data-plugin-link")
  })

  it("renders the highest-priority match", () => {
    register()
    registerLinkMatcher("priority-test", {
      id: "winner",
      patterns: ["example.com/**"],
      priority: 1,
      component: ({ children }) => <strong>{children}</strong>,
    })
    render(<ChatLink href="https://example.com/pr/1">Review</ChatLink>)
    expect(screen.getByText("Review").tagName).toBe("STRONG")
  })

  it("keeps the original accessible link while a lazy component loads", async () => {
    let resolve!: (value: { default: ComponentType<LinkMatcherProps> }) => void
    register(
      lazy(
        () =>
          new Promise<{ default: ComponentType<LinkMatcherProps> }>((done) => {
            resolve = done
          })
      )
    )
    render(
      <p>
        <ChatLink href="https://example.com/pr/1">Review</ChatLink>
      </p>
    )
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank")
    await act(async () => resolve({ default: PluginLink }))
    expect(screen.getByRole("link")).toHaveAttribute("data-plugin-link")
  })

  it("restores the inline original link when a component or lazy import fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    register(
      lazy(async () => {
        throw new Error("load failed")
      })
    )
    const { container } = render(
      <p>
        <ChatLink href="https://example.com/pr/1">Review</ChatLink>
      </p>
    )
    await waitFor(() =>
      expect(screen.getByRole("link").closest("[data-plugin-surface]")).toBeTruthy()
    )
    await act(async () => {})
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank")
    expect(container.querySelector("p div")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    errorSpy.mockRestore()
  })

  describe("presentation (ADR-0218)", () => {
    it("styles web links, adds the site mark and shortens a bare URL", () => {
      const href = "https://github.com/deepseek-ai/dsh-libreoffice-kit"
      render(<ChatLink href={href}>{href}</ChatLink>)
      const link = screen.getByRole("link")
      expect(link).toHaveClass("chat-link")
      expect(link).toHaveAttribute("data-chat-link", "web")
      expect(link).toHaveAttribute("title", href)
      expect(link).toHaveTextContent("deepseek-ai/dsh-libreoffice-kit")
      expect(link.querySelector("[data-link-site-icon]")).toHaveAttribute(
        "data-link-site-icon",
        "brand"
      )
    })

    it("keeps authored link text as written", () => {
      render(<ChatLink href="https://example.com/a">the docs</ChatLink>)
      const link = screen.getByRole("link", { name: "the docs" })
      expect(link).not.toHaveAttribute("title")
    })

    it("leaves non-web links undecorated", () => {
      render(<ChatLink href="mailto:hello@example.com">Email</ChatLink>)
      const link = screen.getByRole("link")
      expect(link).toHaveClass("chat-link")
      expect(link).toHaveAttribute("data-chat-link", "other")
      expect(link.querySelector("[data-link-site-icon]")).toBeNull()
    })

    it("follows the site icon and preview settings", () => {
      render(
        <ChatLinkOptionsProvider
          value={{ ...DEFAULT_MESSAGE_LINK_OPTIONS, siteIcon: false, preview: "off" }}
        >
          <ChatLink href="https://example.com/a">docs</ChatLink>
        </ChatLinkOptionsProvider>
      )
      const link = screen.getByRole("link")
      expect(link.querySelector("[data-link-site-icon]")).toBeNull()
      // With previews off there is no preview trigger around the link.
      expect(link.closest("[data-link-preview-anchor]")).toBeNull()
    })

    it("wraps web links in a preview trigger when previews are on", () => {
      // jsdom's matchMedia reports no hover, so this is the long-press path.
      render(<ChatLink href="https://example.com/a">docs</ChatLink>)
      expect(screen.getByRole("link").closest("[data-link-preview-anchor]")).not.toBeNull()
    })
  })
})
