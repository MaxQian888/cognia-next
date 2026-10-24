import {
  A2UI_ACTION_DATA_LIMIT,
  A2UI_ACTION_DEDUPE_MS,
  A2UI_ACTION_LABEL_LIMIT,
  __resetA2UIChatBindingsForTesting,
  bindA2UISurfaceToChat,
  createA2UIChatActionRouter,
  formatA2UIActionForAgent,
  getA2UIChatBinding,
} from "./chat-action-routing"
import type { A2UISurfaceState, A2UIUserAction } from "@/types/a2ui/schema"

function surface(overrides: Partial<A2UISurfaceState> = {}): A2UISurfaceState {
  return {
    id: "trip",
    type: "inline",
    title: "Trip planner",
    rootId: "root",
    ready: true,
    createdAt: 0,
    updatedAt: 0,
    dataModel: { city: "Hangzhou", nights: 2 },
    components: {
      root: { id: "root", component: "Column", children: ["go", "form", "table", "link"] },
      go: { id: "go", component: "Button", text: "Search", action: "search_hotels" },
      form: { id: "form", component: "FormGroup", children: [] },
      table: { id: "table", component: "Table", columns: [], data: [] },
      link: { id: "link", component: "Link", text: "More", action: "open_more" },
    } as A2UISurfaceState["components"],
    ...overrides,
  }
}

function action(overrides: Partial<A2UIUserAction> = {}): A2UIUserAction {
  return {
    type: "userAction",
    surfaceId: "trip",
    componentId: "go",
    action: "search_hotels",
    data: { text: "Search" },
    timestamp: 0,
    ...overrides,
  }
}

function setup(state = surface()) {
  let clock = 1_000
  const send = jest.fn((_sessionId: string, _text: string) => true)
  const route = createA2UIChatActionRouter({
    getSurface: (id) => (id === state.id ? state : undefined),
    send,
    now: () => clock,
  })
  return {
    route,
    send,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

beforeEach(() => __resetA2UIChatBindingsForTesting())

describe("bindA2UISurfaceToChat", () => {
  it("keeps a surface bound until every render releases it", () => {
    const first = bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const second = bindA2UISurfaceToChat("trip", { sessionId: "s1", messageId: "m1" })
    expect(getA2UIChatBinding("trip")).toEqual({ sessionId: "s1", messageId: "m1" })
    first()
    first()
    expect(getA2UIChatBinding("trip")).toBeDefined()
    second()
    expect(getA2UIChatBinding("trip")).toBeUndefined()
  })

  it("falls back to the still-mounted session when a newer render elsewhere releases", () => {
    const inA = bindA2UISurfaceToChat("calculator", { sessionId: "a" })
    const inB = bindA2UISurfaceToChat("calculator", { sessionId: "b" })
    expect(getA2UIChatBinding("calculator")?.sessionId).toBe("b")
    inB()
    expect(getA2UIChatBinding("calculator")?.sessionId).toBe("a")
    inA()
    expect(getA2UIChatBinding("calculator")).toBeUndefined()
  })
})

describe("createA2UIChatActionRouter", () => {
  it("sends a bound Button click to the session that renders it", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route, send } = setup()
    expect(route(action())).toBe("sent")
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe("s1")
    expect(send.mock.calls[0][1]).toMatch(/^Search\n/)
  })

  it("routes FormGroup submits and Link actions", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route } = setup()
    expect(
      route(action({ componentId: "form", action: "formSubmit", data: { values: { a: 1 } } }))
    ).toBe("sent")
    expect(route(action({ componentId: "link", action: "open_more", data: {} }))).toBe("sent")
  })

  it("leaves unbound surfaces local", () => {
    const { route, send } = setup()
    expect(route(action())).toBe("unbound")
    expect(send).not.toHaveBeenCalled()
  })

  it("never routes non-gesture components or unknown component ids", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route, send } = setup()
    expect(route(action({ componentId: "table", action: "row_click" }))).toBe("not-routable")
    expect(route(action({ componentId: "missing" }))).toBe("not-routable")
    expect(send).not.toHaveBeenCalled()
  })

  it("does not answer a connector callback that the IM path already owns", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route, send } = setup()
    expect(route(action({ data: { source: "connector", value: "go" } }))).toBe("not-routable")
    expect(send).not.toHaveBeenCalled()
  })

  it("drops a double click but accepts the same gesture after the window", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route, send, advance } = setup()
    expect(route(action())).toBe("sent")
    advance(A2UI_ACTION_DEDUPE_MS - 1)
    expect(route(action())).toBe("duplicate")
    advance(1)
    expect(route(action())).toBe("sent")
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("reports a failed send and lets the user retry immediately", () => {
    bindA2UISurfaceToChat("trip", { sessionId: "s1" })
    const { route, send } = setup()
    send.mockReturnValueOnce(false)
    expect(route(action())).toBe("failed")
    expect(route(action())).toBe("sent")
  })
})

describe("formatA2UIActionForAgent", () => {
  function record(text: string) {
    const body = text.split("```a2ui-action\n")[1].split("\n```")[0]
    return JSON.parse(body) as Record<string, unknown>
  }

  it("leads with the control's label and carries the action and data snapshot", () => {
    const text = formatA2UIActionForAgent(action(), surface(), "Button")
    expect(text.split("\n")[0]).toBe("Search")
    expect(record(text)).toEqual({
      surfaceId: "trip",
      surfaceTitle: "Trip planner",
      componentId: "go",
      componentType: "Button",
      action: "search_hotels",
      dataModel: { city: "Hangzhou", nights: 2 },
    })
  })

  it("falls back to the action name and keeps action data other than the label", () => {
    const text = formatA2UIActionForAgent(
      action({ componentId: "form", action: "book", data: { values: { nights: 3 } } }),
      surface({ dataModel: {} }),
      "FormGroup"
    )
    expect(text.split("\n")[0]).toBe("book")
    expect(record(text)).toMatchObject({ data: { values: { nights: 3 } } })
    expect(record(text)).not.toHaveProperty("dataModel")
  })

  it("replaces an oversized data snapshot with its size", () => {
    const big = { blob: "x".repeat(A2UI_ACTION_DATA_LIMIT) }
    const text = formatA2UIActionForAgent(action(), surface({ dataModel: big }), "Button")
    expect(record(text).dataModel).toEqual({
      truncated: true,
      bytes: JSON.stringify(big).length,
    })
  })

  it("caps oversized action data (a form's values) and a long label", () => {
    const values = { notes: "n".repeat(A2UI_ACTION_DATA_LIMIT) }
    const text = formatA2UIActionForAgent(
      action({ data: { text: "x".repeat(500), values } }),
      surface({ dataModel: values }),
      "FormGroup"
    )
    expect(text.split("\n")[0]).toHaveLength(A2UI_ACTION_LABEL_LIMIT)
    const body = JSON.parse(text.split("```a2ui-action\n")[1].split("\n```")[0])
    expect(body.data).toEqual({ truncated: true, bytes: expect.any(Number) })
    expect(body.dataModel).toEqual({ truncated: true, bytes: expect.any(Number) })
  })

  it("is not itself parsed as an A2UI payload", () => {
    const { detectA2UIContent } = jest.requireActual("./parser")
    expect(detectA2UIContent(formatA2UIActionForAgent(action(), surface(), "Button"))).toBe(false)
  })
})
