/**
 * The sidecar matches `SendOptions.alwaysExplicitTools` entries with its own
 * copy of the host's tool-name reduction, because it cannot import `lib/`
 * (ADR-0239). If the two drifted, a listed outbound tool could slip past the
 * always-ask under a name only one side recognised. This pins them equal.
 */
import { explicitToolName } from "../../../sidecar/src/policy/permission/permission-classes.ts"

import { normalizeToolId, OUTBOUND_TOOL_IDS } from "./outbound-tools"

const NAMES = [
  "send_email",
  "mcp__cognia-tools__send_email",
  "mcp__cognia-plugin-tools__im_broadcast",
  "mcp__some-server__Send_Message ",
  "mcp__a__b__connector_send",
  "Bash",
  "",
  "__",
  ...OUTBOUND_TOOL_IDS,
]

describe("outbound tool names: host and sidecar reduce them alike", () => {
  it.each(NAMES)("%j", (name) => {
    expect(explicitToolName(name)).toBe(normalizeToolId(name))
  })
})
