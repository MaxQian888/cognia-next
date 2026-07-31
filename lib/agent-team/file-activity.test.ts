import { extractAgentFileActivity } from "./file-activity"

describe("extractAgentFileActivity", () => {
  it("extracts a read target and its first revealed line", () => {
    expect(
      extractAgentFileActivity("Read", '{"file_path":"src/app.ts","offset":42,"limit":20}')
    ).toEqual({ path: "src/app.ts", line: 42, timing: "start" })
  })

  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
    "waits for a successful %s result before following the file",
    (name) => {
      expect(extractAgentFileActivity(name, '{"path":"/repo/src/app.ts"}')).toEqual({
        path: "/repo/src/app.ts",
        timing: "success",
      })
    }
  )

  it("supports workspace file transport tool names and structured input", () => {
    expect(
      extractAgentFileActivity("fs_read_workspace_file", {
        path: "lib/config.ts",
        line_number: 7,
        column: 3,
      })
    ).toEqual({ path: "lib/config.ts", line: 7, column: 3, timing: "start" })
  })

  it.each([
    ["Bash", '{"command":"cat src/app.ts"}'],
    ["Read", "not-json"],
    ["Read", '{"file_path":""}'],
    ["Read", '{"file_path":"src/app.ts","offset":0}'],
  ])("ignores unsupported or invalid activity from %s", (name, input) => {
    expect(extractAgentFileActivity(name, input)).toBeNull()
  })
})
