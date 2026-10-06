/** Shared, ephemeral extension presentation state used by desktop and CLI. */
import type {
  ExternalAgentUiState,
  ExternalAgentUiUpdateEvent,
} from "@cognia/agent-contracts/external-agent"

export function createExternalAgentUiState(): ExternalAgentUiState {
  return { statuses: {}, widgets: {}, notifications: [] }
}

/** Keyed replacement/removal mirrors the runtime contract without transcript noise. */
export function reduceExternalAgentUiState(
  state: ExternalAgentUiState,
  event: ExternalAgentUiUpdateEvent
): ExternalAgentUiState {
  const update = event.update
  switch (update.kind) {
    case "status": {
      const statuses = { ...state.statuses }
      if (update.text === null) delete statuses[update.key]
      else
        Object.defineProperty(statuses, update.key, {
          value: update.text,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      return { ...state, statuses }
    }
    case "widget": {
      const widgets = { ...state.widgets }
      if (update.lines === null) delete widgets[update.key]
      else
        Object.defineProperty(widgets, update.key, {
          value: { lines: [...update.lines], placement: update.placement },
          enumerable: true,
          configurable: true,
          writable: true,
        })
      return { ...state, widgets }
    }
    case "title":
      return { ...state, title: update.title }
    case "editor":
      return { ...state, editor: { id: event.id, text: update.text } }
    case "notification":
      if (state.notifications.some((item) => item.id === event.id)) return state
      return {
        ...state,
        notifications: [
          ...state.notifications.slice(-49),
          { id: event.id, level: update.level, message: update.message },
        ],
      }
  }
}
