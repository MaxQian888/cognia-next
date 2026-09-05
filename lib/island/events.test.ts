import {
  ISLAND_ACTION_INTENT_EVENT,
  ISLAND_ACTION_RESULT_EVENT,
  ISLAND_DETAIL_REQUEST_EVENT,
  ISLAND_DETAIL_RESPONSE_EVENT,
  ISLAND_EVENTS,
  ISLAND_STATE_EVENT,
  ISLAND_STATE_REQUEST_EVENT,
  ISLAND_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
} from "./events"

describe("island event vocabulary", () => {
  it("is exactly six unique topics, all namespaced", () => {
    expect(ISLAND_EVENTS).toHaveLength(6)
    expect(new Set(ISLAND_EVENTS).size).toBe(6)
    for (const event of ISLAND_EVENTS) expect(event.startsWith("island://")).toBe(true)
  })

  it("lists every topic both directions of the bridge uses", () => {
    // A topic missing here is a topic one side could listen to while the other
    // never emits it, which is the failure this list exists to make loud.
    expect([...ISLAND_EVENTS].sort()).toEqual(
      [
        ISLAND_STATE_EVENT,
        ISLAND_STATE_REQUEST_EVENT,
        ISLAND_ACTION_INTENT_EVENT,
        ISLAND_ACTION_RESULT_EVENT,
        ISLAND_DETAIL_REQUEST_EVENT,
        ISLAND_DETAIL_RESPONSE_EVENT,
      ].sort()
    )
  })

  it("names the two windows the bridge addresses", () => {
    expect(ISLAND_WINDOW_LABEL).toBe("island")
    expect(MAIN_WINDOW_LABEL).toBe("main")
  })
})
