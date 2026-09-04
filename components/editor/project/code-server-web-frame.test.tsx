/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

import { CodeServerWebFrame } from "./code-server-web-frame"
import type { CodeServerStatus } from "@/lib/codeserver/client"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

function status(over: Partial<CodeServerStatus> = {}): CodeServerStatus {
  return { running: true, port: 41234, version: "1.0.0", ...over }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("<CodeServerWebFrame />", () => {
  it("frames the host's loopback port when the host is this machine", () => {
    render(<CodeServerWebFrame status={status()} hostBaseUrl="http://127.0.0.1:27891" />)
    const frame = screen.getByTestId("code-server-web-frame")
    expect(frame).toHaveAttribute("src", "http://127.0.0.1:41234/")
  })

  it("explains instead of framing when the host is another machine", () => {
    render(<CodeServerWebFrame status={status()} hostBaseUrl="https://192.168.1.20:27890" />)
    expect(screen.queryByTestId("code-server-web-frame")).not.toBeInTheDocument()
    expect(screen.getByTestId("code-server-web-frame-unavailable")).toHaveAttribute(
      "data-cause",
      "needs-host-browser"
    )
  })

  it("says nothing is running rather than showing an empty frame", () => {
    render(
      <CodeServerWebFrame status={status({ running: false, port: null })} hostBaseUrl={null} />
    )
    expect(screen.getByTestId("code-server-web-frame-unavailable")).toHaveAttribute(
      "data-cause",
      "not-running"
    )
  })

  it("falls back to a link when the frame never loads", () => {
    // A `frame-ancestors` refusal fires no error event and throws nothing, so
    // the deadline is the only signal that the embed did not happen.
    render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl="http://127.0.0.1:27891"
        loadBudgetMs={5_000}
      />
    )
    expect(screen.getByTestId("code-server-web-frame")).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(5_000)
    })

    expect(screen.queryByTestId("code-server-web-frame")).not.toBeInTheDocument()
    const refused = screen.getByTestId("code-server-web-frame-refused")
    expect(refused).toHaveAttribute("data-cause", "framing-refused")
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "http://127.0.0.1:41234/")
    // The workbench runs with `--auth none`, so no child window keeps a
    // handle back to the page that opened it.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("keeps the frame when it loads inside the budget", () => {
    render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl="http://127.0.0.1:27891"
        loadBudgetMs={5_000}
      />
    )
    act(() => {
      screen.getByTestId("code-server-web-frame").dispatchEvent(new Event("load"))
      jest.advanceTimersByTime(5_000)
    })
    expect(screen.getByTestId("code-server-web-frame")).toBeInTheDocument()
  })

  it("re-arms for a restarted workbench on a new port", () => {
    // The refusal is keyed by URL, so a workbench that comes back on a
    // different port gets a fresh attempt rather than inheriting the verdict.
    const { rerender } = render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl="http://127.0.0.1:27891"
        loadBudgetMs={5_000}
      />
    )
    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    expect(screen.getByTestId("code-server-web-frame-refused")).toBeInTheDocument()

    rerender(
      <CodeServerWebFrame
        status={status({ port: 51000 })}
        hostBaseUrl="http://127.0.0.1:27891"
        loadBudgetMs={5_000}
      />
    )
    expect(screen.getByTestId("code-server-web-frame")).toHaveAttribute(
      "src",
      "http://127.0.0.1:51000/"
    )
  })
})

describe("reporting whether the workbench is on screen", () => {
  // A caller that acts on the workbench being visible — the pane registering it
  // as the project-editor opener — cannot derive this from the target alone:
  // whether code-server consents to being framed is only knowable at runtime.
  it("reports embedded once the frame is shown", () => {
    const onEmbeddedChange = jest.fn()
    render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl="http://127.0.0.1:27891"
        onEmbeddedChange={onEmbeddedChange}
      />
    )
    expect(onEmbeddedChange).toHaveBeenLastCalledWith(true)
  })

  it("reports not-embedded when there is nothing to frame", () => {
    const onEmbeddedChange = jest.fn()
    render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl="https://192.168.1.20:27890"
        onEmbeddedChange={onEmbeddedChange}
      />
    )
    expect(onEmbeddedChange).toHaveBeenLastCalledWith(false)
  })

  it("withdraws it when the frame misses its load deadline", () => {
    const onEmbeddedChange = jest.fn()
    render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl={null}
        loadBudgetMs={100}
        onEmbeddedChange={onEmbeddedChange}
      />
    )
    expect(onEmbeddedChange).toHaveBeenLastCalledWith(true)

    act(() => void jest.advanceTimersByTime(101))

    expect(screen.getByTestId("code-server-web-frame-refused")).toBeInTheDocument()
    expect(onEmbeddedChange).toHaveBeenLastCalledWith(false)
  })

  it("withdraws it on unmount, which takes the workbench off screen too", () => {
    const onEmbeddedChange = jest.fn()
    const { unmount } = render(
      <CodeServerWebFrame
        status={status()}
        hostBaseUrl={null}
        onEmbeddedChange={onEmbeddedChange}
      />
    )
    onEmbeddedChange.mockClear()
    unmount()
    expect(onEmbeddedChange).toHaveBeenLastCalledWith(false)
  })
})
