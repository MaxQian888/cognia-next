import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { deleteGatewayTask, gatewayRuntimeEnvironment, prepareGatewayTask } from "./gateway-task"

describe("gateway task host state", () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-gateway-host-test-"))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
  const config = (taskId = "task-one", modelId = "model") => ({
    id: taskId,
    command: "pi",
    env: {
      COGNIA_GATEWAY_TOKEN: "temporary-lease",
      COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({
        taskId,
        binding: { providerId: "provider", modelId },
        runtime: "pi",
        ownerAccountId: "local-owner",
        files: { "pi/models.json": '{"apiKey":"$COGNIA_GATEWAY_TOKEN"}' },
      }),
    },
  })

  it("keeps native conversation state across fresh leases and cleans generated files", () => {
    const first = prepareGatewayTask(config(), home)
    const taskHome = first.config.env!.HOME
    const history = path.join(taskHome, "pi", "session.jsonl")
    fs.writeFileSync(history, "previous turn")
    expect(first.config.env!.COGNIA_GATEWAY_TASK_CONFIG).toBeUndefined()
    expect(fs.readFileSync(path.join(taskHome, "pi/models.json"), "utf8")).not.toContain(
      "temporary-lease"
    )
    first.cleanup()
    expect(fs.existsSync(path.join(taskHome, "pi/models.json"))).toBe(false)
    const resumed = prepareGatewayTask(config(), home)
    expect(resumed.config.env!.HOME).toBe(taskHome)
    expect(fs.readFileSync(history, "utf8")).toBe("previous turn")
    resumed.cleanup()
    const otherOwner = config()
    otherOwner.env.COGNIA_GATEWAY_TASK_CONFIG = otherOwner.env.COGNIA_GATEWAY_TASK_CONFIG.replace(
      "local-owner",
      "other-owner"
    )
    expect(() => prepareGatewayTask(otherOwner, home)).toThrow("different model")
    expect(() => prepareGatewayTask(config("task-one", "other"), home)).toThrow("different model")
    deleteGatewayTask("task-one", home)
    expect(fs.existsSync(taskHome)).toBe(false)
  })

  it("isolates independent tasks and rejects traversal", () => {
    const first = prepareGatewayTask(config("one"), home)
    const second = prepareGatewayTask(config("two"), home)
    expect(first.config.env!.HOME).not.toBe(second.config.env!.HOME)
    expect(() => prepareGatewayTask(config("../escape"), home)).toThrow()
    first.cleanup()
    second.cleanup()
  })

  it("pins Qwen system overrides and persistent history inside the task", () => {
    const input = config()
    const payload = JSON.parse(input.env.COGNIA_GATEWAY_TASK_CONFIG)
    payload.runtime = "qwen"
    payload.files = { "qwen/settings.json": '{"modelProviders":{}}' }
    input.env.COGNIA_GATEWAY_TASK_CONFIG = JSON.stringify(payload)
    const first = prepareGatewayTask(input, home)
    const env = first.config.env!
    expect(env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(path.join(env.QWEN_HOME, "settings.json"))
    expect(env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(env.QWEN_CODE_SYSTEM_SETTINGS_PATH)
    const history = path.join(env.QWEN_RUNTIME_DIR, "session.jsonl")
    fs.writeFileSync(history, "history")
    first.cleanup()
    expect(fs.existsSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH)).toBe(false)
    const resumed = prepareGatewayTask(input, home)
    expect(
      fs.readFileSync(path.join(resumed.config.env!.QWEN_RUNTIME_DIR, "session.jsonl"), "utf8")
    ).toBe("history")
    resumed.cleanup()
  })

  it("inherits runtime essentials without provider keys or configuration", () => {
    expect(
      gatewayRuntimeEnvironment({
        PATH: "/bin",
        OPENAI_API_KEY: "upstream",
        CODEX_HOME: "/user",
        HOME: "/user",
        NODE_OPTIONS: "--require evil",
        SSL_CERT_FILE: "/cert",
      })
    ).toEqual({ PATH: "/bin", SSL_CERT_FILE: "/cert" })
  })
})
