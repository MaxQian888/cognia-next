import { kimiManagementCommand } from "./kimi-management"

describe("kimiManagementCommand", () => {
  it("pins installation and restore without exposing runtime secrets", () => {
    const agent = { process: { command: "kimi", env: { KIMI_MODEL_API_KEY: "private" } } }
    expect(kimiManagementCommand(agent, "install")).toBe(
      "npm install --global @moonshot-ai/kimi-code@2.1.1"
    )
    expect(kimiManagementCommand(agent, "restore")).toBe(kimiManagementCommand(agent, "install"))
    expect(kimiManagementCommand(agent, "uninstall")).toBe(
      "npm uninstall --global @moonshot-ai/kimi-code"
    )
  })

  it("quotes executable and state paths, preserves spaces, and drops ACP arguments/secrets", () => {
    const agent = {
      process: {
        command: "/opt/Kimi CLI/kimi",
        args: ["acp"],
        cwd: "/workspace",
        env: { KIMI_CODE_HOME: " /state/a'b ", KIMI_MODEL_API_KEY: "private" },
      },
    }
    expect(kimiManagementCommand(agent, "web")).toBe(
      "cd -- /workspace && env 'KIMI_CODE_HOME= /state/a'\\''b ' '/opt/Kimi CLI/kimi' web"
    )
    expect(kimiManagementCommand(agent, "native")).not.toContain("acp")
    expect(kimiManagementCommand(agent, "doctor")).not.toContain("private")
  })

  it("exports an explicit native session without other projects' global log", () => {
    expect(kimiManagementCommand({}, "export", "session; touch /tmp/no")).toBe(
      "kimi export 'session; touch /tmp/no' --no-include-global-log"
    )
    for (const id of [undefined, "", " ", "--yes", "a\0b"]) {
      expect(() => kimiManagementCommand({}, "export", id)).toThrow()
    }
  })

  it("rejects invalid state roots before copying or launching", () => {
    for (const home of ["", " ", "a\0b"]) {
      expect(() =>
        kimiManagementCommand(
          { process: { command: "kimi", env: { KIMI_CODE_HOME: home } } },
          "web"
        )
      ).toThrow()
    }
  })

  it("anchors copied relative state roots to the configured working directory", () => {
    const agent = {
      process: {
        command: "kimi",
        cwd: "/work/a'b; $HOME",
        env: { KIMI_CODE_HOME: "./state folder" },
      },
    }
    expect(kimiManagementCommand(agent, "doctor")).toBe(
      "cd -- '/work/a'\\''b; $HOME' && env 'KIMI_CODE_HOME=./state folder' kimi doctor"
    )
  })

  it("refuses relative state roots without an absolute working directory", () => {
    for (const cwd of [undefined, "", " ", "relative", "/root\0bad"]) {
      expect(() =>
        kimiManagementCommand(
          { process: { command: "kimi", cwd, env: { KIMI_CODE_HOME: "./state" } } },
          "web"
        )
      ).toThrow()
    }
    expect(
      kimiManagementCommand(
        { process: { command: "kimi", cwd: "", env: { KIMI_CODE_HOME: "/owned/state" } } },
        "web"
      )
    ).toBe("env KIMI_CODE_HOME=/owned/state kimi web")
  })
})
