import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  AGENT_OPERATIONS,
  AgentOperationError,
  isAgentOperation,
  parseHostFrame,
  serializeFrame,
  toFailure,
} from "./protocol"

describe("device socket protocol", () => {
  it("lists exactly the operations the Rust socket forwards", () => {
    const rust = readFileSync(
      join(__dirname, "../../../../crates/cognia-companion/src/ws_browser_companion.rs"),
      "utf8"
    )
    const block = rust.slice(
      rust.indexOf("pub const OPERATIONS"),
      rust.indexOf("];", rust.indexOf("pub const OPERATIONS"))
    )
    const names = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
    expect([...names].sort()).toEqual([...AGENT_OPERATIONS].sort())
  })

  it("parses the frames the Host sends", () => {
    expect(parseHostFrame('{"t":"welcome","v":1,"connectionId":"c","driveAllowed":true}')).toEqual({
      t: "welcome",
      v: 1,
      connectionId: "c",
      driveAllowed: true,
    })
    expect(
      parseHostFrame('{"t":"op","id":"1","op":"snapshot","args":{"session":"s"},"deadlineMs":5000}')
    ).toEqual({ t: "op", id: "1", op: "snapshot", args: { session: "s" }, deadlineMs: 5000 })
    expect(parseHostFrame('{"t":"status","at":9}')).toEqual({ t: "status", at: 9 })
    expect(parseHostFrame('{"t":"drive","allowed":false}')).toEqual({ t: "drive", allowed: false })
    expect(parseHostFrame('{"t":"heartbeat"}')).toEqual({ t: "heartbeat" })
  })

  it("keeps an unknown operation answerable, and ignores unknown frames", () => {
    const frame = parseHostFrame('{"t":"op","id":"7","op":"run_shell","args":{}}')
    expect(frame).toMatchObject({ t: "op", id: "7" })
    expect(frame && "op" in frame && isAgentOperation(frame.op)).toBe(false)
    expect(parseHostFrame('{"t":"future"}')).toBeNull()
    expect(parseHostFrame("not json")).toBeNull()
    expect(parseHostFrame('{"t":"op","op":"snapshot"}')).toBeNull()
  })

  it("serializes answers and keeps refusal codes", () => {
    expect(JSON.parse(serializeFrame({ t: "result", id: "1", ok: true, value: 3 }))).toEqual({
      t: "result",
      id: "1",
      ok: true,
      value: 3,
    })
    expect(toFailure(new AgentOperationError("browser_user_takeover", "taken over"))).toEqual({
      code: "browser_user_takeover",
      message: "taken over",
    })
    expect(toFailure(new Error("boom"))).toEqual({
      code: "browser_extension_error",
      message: "boom",
    })
  })
})
