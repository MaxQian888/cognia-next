/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { animate } from "motion/react"

import { useSettingsStore } from "@/stores/settings/settings-store"

import {
  CHAT_SESSION_SETTLE,
  ChatSurfaceTransition,
  chatSurfaceDirection,
  chatSurfaceVariants,
  type ChatSurface,
  type ChatSurfaceDirection,
} from "./chat-surface-transition"

// The shared `motion/react` mock renders `AnimatePresence` as a pass-through,
// which cannot show an exit at all. This suite is about exits, so it runs the
// real library (its CommonJS build, resolved through `motion`'s own
// dependency) with only the imperative `animate` stubbed for assertions.
jest.mock("motion/react", () => {
  const path = jest.requireActual<typeof import("path")>("path")
  const framer = jest.requireActual(
    require.resolve("framer-motion", {
      paths: [path.dirname(require.resolve("motion/package.json"))],
    })
  )
  return { ...framer, animate: jest.fn(() => ({ stop: jest.fn() })) }
})

const animateMock = animate as unknown as jest.Mock

type Target = Record<string, unknown> & { transition?: { duration: number } }

/**
 * The target a surface animates to. Enter and center come from the direction
 * the surface entered by; exit from the presence's custom at removal time.
 */
function variant(name: "enter" | "center" | "exit", direction: number, durationScale = 1) {
  const variants = chatSurfaceVariants(direction as ChatSurfaceDirection, durationScale)
  const definition = variants[name]
  return (
    typeof definition === "function"
      ? (definition as (custom: unknown) => Target)({ direction, durationScale })
      : definition
  ) as Target
}

function setMotion(reduce: boolean, speed = 1) {
  useSettingsStore.setState({ settings: { motion: { reduce, speed } } as never })
}

function Pane({ surface, sessionId }: { surface: ChatSurface; sessionId: string | null }) {
  return (
    <ChatSurfaceTransition surface={surface} sessionId={sessionId}>
      <p data-testid={`content-${surface}`}>{`${surface}:${sessionId ?? "none"}`}</p>
    </ChatSurfaceTransition>
  )
}

describe("chatSurfaceDirection", () => {
  it("goes deeper from home or notice into a conversation", () => {
    expect(chatSurfaceDirection("home", "conversation")).toBe(1)
    expect(chatSurfaceDirection("notice", "conversation")).toBe(1)
  })

  it("comes back out from a conversation", () => {
    expect(chatSurfaceDirection("conversation", "home")).toBe(-1)
    expect(chatSurfaceDirection("conversation", "notice")).toBe(-1)
  })

  it("moves sideways between surfaces of the same depth", () => {
    expect(chatSurfaceDirection("home", "notice")).toBe(0)
  })
})

describe("chatSurfaceVariants", () => {
  it("rises a conversation in from below and recedes the welcome upwards", () => {
    expect(variant("enter", 1)).toMatchObject({ opacity: 0, y: 18, scale: 0.985 })
    expect(variant("exit", 1)).toMatchObject({ opacity: 0, y: -10, scale: 0.98 })
  })

  it("settles the welcome back from above and sinks the conversation away", () => {
    expect(variant("enter", -1)).toMatchObject({ opacity: 0, y: -12, scale: 1.015 })
    expect(variant("exit", -1)).toMatchObject({ opacity: 0, y: 16, scale: 0.99 })
  })

  it("only crossfades between surfaces of the same depth", () => {
    expect(variant("enter", 0)).toMatchObject({ opacity: 0, y: 6, scale: 1 })
    expect(variant("exit", 0)).toMatchObject({ opacity: 0, y: 0, scale: 1 })
  })

  it("lands every surface at rest", () => {
    expect(variant("center", 1)).toMatchObject({ opacity: 1, y: 0, scale: 1 })
  })

  it("scales durations by the speed preference, exits quicker than entrances", () => {
    const enterIn = variant("center", 1, 2).transition!.duration
    const exitOut = variant("exit", 1, 2).transition!.duration
    expect(enterIn).toBeCloseTo(variant("center", 1).transition!.duration * 2)
    expect(exitOut).toBeLessThan(enterIn)
  })

  it("leaves by the move that removed the surface, not the one that brought it in", () => {
    // A conversation entered from home (direction 1), then left for home.
    const exit = chatSurfaceVariants(1, 1).exit as (custom: unknown) => Target
    expect(exit({ direction: -1, durationScale: 1 })).toMatchObject({ y: 16, scale: 0.99 })
    // Without a presence value it falls back to a plain fade.
    expect(exit(undefined)).toMatchObject({ opacity: 0, y: 0, scale: 1 })
  })
})

describe("<ChatSurfaceTransition />", () => {
  beforeEach(() => animateMock.mockClear())

  it("renders the surface inside a positioned stage that tags it", () => {
    setMotion(false)
    render(<Pane surface="home" sessionId={null} />)
    // Motion props stay off the DOM.
    expect(document.querySelector("[custom]")).toBeNull()
    const stage = document.querySelector('[data-slot="chat-surface"]')!
    expect(stage).toHaveAttribute("data-surface", "home")
    expect(stage.className).toContain("relative")
    expect(screen.getByTestId("content-home")).toBeInTheDocument()
  })

  it("swaps surfaces instantly under reduced motion", () => {
    setMotion(true)
    const view = render(<Pane surface="home" sessionId={null} />)
    view.rerender(<Pane surface="conversation" sessionId="a" />)
    expect(screen.getByTestId("content-conversation")).toBeInTheDocument()
    expect(screen.queryByTestId("content-home")).not.toBeInTheDocument()
  })

  it("keeps the leaving surface for its exit, then removes it and reports completion", async () => {
    setMotion(false)
    const onExitComplete = jest.fn()
    const view = render(
      <ChatSurfaceTransition surface="home" sessionId={null} onExitComplete={onExitComplete}>
        <p data-testid="content-home">home</p>
      </ChatSurfaceTransition>
    )
    view.rerender(
      <ChatSurfaceTransition surface="conversation" sessionId="a" onExitComplete={onExitComplete}>
        <p data-testid="content-conversation">conversation</p>
      </ChatSurfaceTransition>
    )
    expect(screen.getByTestId("content-conversation")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="chat-surface"]')).toHaveAttribute(
      "data-surface",
      "conversation"
    )
    // The leaving surface is still there during its exit…
    expect(screen.getByTestId("content-home")).toBeInTheDocument()
    expect(onExitComplete).not.toHaveBeenCalled()
    // …and gone once it has played (fast exit, well under this window).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    expect(screen.queryByTestId("content-home")).not.toBeInTheDocument()
    expect(onExitComplete).toHaveBeenCalledTimes(1)
  })

  it("keeps the conversation surface mounted across a session switch and settles the stage", () => {
    setMotion(false, 2)
    const view = render(<Pane surface="conversation" sessionId="a" />)
    const before = screen.getByTestId("content-conversation")
    expect(animateMock).not.toHaveBeenCalled()

    view.rerender(<Pane surface="conversation" sessionId="b" />)
    // Same node: the conversation's subtree is not torn down.
    expect(screen.getByTestId("content-conversation")).toBe(before)
    expect(before).toHaveTextContent("conversation:b")
    expect(animateMock).toHaveBeenCalledTimes(1)
    const [target, keyframes, options] = animateMock.mock.calls[0]
    expect(target).toBe(document.querySelector('[data-slot="chat-surface"]'))
    expect(keyframes).toEqual(CHAT_SESSION_SETTLE.keyframes)
    // Speed 2× halves the duration.
    expect(options.duration).toBeCloseTo(CHAT_SESSION_SETTLE.duration * 0.5)
  })

  it("does not settle when the surface itself changes, or under reduced motion", () => {
    setMotion(false)
    const view = render(<Pane surface="home" sessionId={null} />)
    view.rerender(<Pane surface="conversation" sessionId="a" />)
    expect(animateMock).not.toHaveBeenCalled()

    act(() => setMotion(true))
    view.rerender(<Pane surface="conversation" sessionId="b" />)
    expect(animateMock).not.toHaveBeenCalled()
  })
})
