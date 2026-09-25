import manifestJson from "../plugin.json"
import { PANEL_ACTIVITY, PANEL_FULL_ID, PANEL_ID, PLUGIN_ID, sreSubagentRuntimeId } from "./ids"

it("matches the manifest id and namespaces the panel and subagent under it", () => {
  expect(PLUGIN_ID).toBe(manifestJson.id)
  expect(PANEL_FULL_ID).toBe(`${PLUGIN_ID}:${PANEL_ID}`)
  expect(sreSubagentRuntimeId()).toBe(`${PLUGIN_ID}:${manifestJson.subagents[0].id}`)
  // Its own rail group, not the crowded built-in `inspect` activity.
  expect(PANEL_ACTIVITY).not.toBe("inspect")
})
