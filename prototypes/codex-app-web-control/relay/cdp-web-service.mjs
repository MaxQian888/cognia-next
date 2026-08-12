import { CDP_WEB_LABEL_PREFIX, defaultStateDir, relayPaths, workerPath } from "./shared.mjs"

export function cdpWebLabel(uid = process.getuid()) {
  return `${CDP_WEB_LABEL_PREFIX}.${uid}`
}

export function buildCdpWebService({
  launchId,
  stateDir = defaultStateDir(),
  forwardedArgs = [],
  label = cdpWebLabel(),
}) {
  const paths = relayPaths(stateDir)
  return {
    label,
    paths,
    launchArgs: [
      "submit",
      "-l",
      label,
      "-o",
      paths.cdpWebStdout,
      "-e",
      paths.cdpWebStderr,
      "--",
      process.execPath,
      workerPath("cdp-web.mjs"),
      "--launchd-service",
      "--launch-id",
      launchId,
      "--state-dir",
      paths.root,
      ...forwardedArgs,
    ],
  }
}
