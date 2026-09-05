/**
 * The complete cross-window event vocabulary for the task control island.
 *
 * Exactly six topics, defined once. No component builds an event name by hand,
 * so a rename cannot leave one side of the bridge listening to a topic nobody
 * emits any more. Three flow main to island (state, action result, detail
 * response) and three flow island to main (state request, action intent,
 * detail request).
 */

export const ISLAND_WINDOW_LABEL = "island"
export const MAIN_WINDOW_LABEL = "main"

/** Main to island: a fresh read-only projection. */
export const ISLAND_STATE_EVENT = "island://state"
/** Island to main: "I am mounted, send me state". */
export const ISLAND_STATE_REQUEST_EVENT = "island://state-request"
/** Island to main: the user asked for something to happen. */
export const ISLAND_ACTION_INTENT_EVENT = "island://action-intent"
/** Main to island: what happened to that intent. */
export const ISLAND_ACTION_RESULT_EVENT = "island://action-result"
/** Island to main: the user pinned a row and wants its detail. */
export const ISLAND_DETAIL_REQUEST_EVENT = "island://detail-request"
/** Main to island: redacted detail, or a refusal. */
export const ISLAND_DETAIL_RESPONSE_EVENT = "island://detail-response"

/** Every topic, for the gate test that pins the vocabulary. */
export const ISLAND_EVENTS = [
  ISLAND_STATE_EVENT,
  ISLAND_STATE_REQUEST_EVENT,
  ISLAND_ACTION_INTENT_EVENT,
  ISLAND_ACTION_RESULT_EVENT,
  ISLAND_DETAIL_REQUEST_EVENT,
  ISLAND_DETAIL_RESPONSE_EVENT,
] as const
