import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  LOCAL_ENVIRONMENT_COMMAND,
  LOCAL_ENVIRONMENT_COMMANDS,
  localInvocation,
} from "./local-environment-commands"

describe("local environment commands", () => {
  it("are exactly the Host arm's COMMANDS", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri/src/companion_api/rpc/environment.rs"),
      "utf8"
    )
    const block = source.match(/pub\(super\) const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)
    expect(block).not.toBeNull()
    const rust = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
    expect(new Set(rust)).toEqual(new Set(LOCAL_ENVIRONMENT_COMMANDS))
  })

  it("routes an environment command through the local dispatcher", () => {
    expect(localInvocation("environment_driver_status", { a: 1 })).toEqual({
      command: LOCAL_ENVIRONMENT_COMMAND,
      args: { name: "environment_driver_status", args: { a: 1 } },
    })
    expect(localInvocation("environment_catalog_list")).toEqual({
      command: LOCAL_ENVIRONMENT_COMMAND,
      args: { name: "environment_catalog_list", args: {} },
    })
  })

  it("leaves every other command untouched", () => {
    expect(localInvocation("greet", { name: "x" })).toEqual({
      command: "greet",
      args: { name: "x" },
    })
    expect(localInvocation(LOCAL_ENVIRONMENT_COMMAND)).toEqual({
      command: LOCAL_ENVIRONMENT_COMMAND,
      args: undefined,
    })
  })
})
