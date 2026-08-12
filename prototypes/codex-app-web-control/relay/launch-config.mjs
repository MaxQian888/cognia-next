export function buildAppServerEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name !== "CODEX_CLI_PATH" && !name.startsWith("CODEX_RELAY_")
    )
  )
}

export function buildRelayOpenArgs({
  appPath,
  cdpPort,
  nodeDirectory,
  port,
  realCli,
  shim,
  stateDir,
  workspace,
}) {
  const environment = [
    `CODEX_CLI_PATH=${shim}`,
    `CODEX_RELAY_REAL_CLI=${realCli}`,
    `CODEX_RELAY_STATE_DIR=${stateDir}`,
    `CODEX_RELAY_PORT=${port}`,
    `CODEX_RELAY_WORKSPACE=${workspace}`,
    ...(cdpPort == null ? [] : [`CODEX_RELAY_CDP_PORT=${cdpPort}`]),
    `PATH=${[
      nodeDirectory,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":")}`,
  ]
  return [
    "--new",
    ...environment.flatMap((entry) => ["--env", entry]),
    appPath,
    ...(cdpPort == null
      ? []
      : ["--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`]),
  ]
}

export function buildDaemonAppOpenArgs({ appPath, nodeDirectory }) {
  const path = [
    nodeDirectory,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":")
  return [
    "--new",
    "--env",
    "CODEX_APP_SERVER_USE_LOCAL_DAEMON=1",
    "--env",
    "CODEX_APP_SERVER_FORCE_CLI=",
    "--env",
    "CODEX_CLI_PATH=",
    "--env",
    `PATH=${path}`,
    appPath,
  ]
}

export function buildCdpOnlyAppOpenArgs({ appPath, cdpPort }) {
  return [
    "--new",
    appPath,
    "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
  ]
}
