export * from "./types"
export * from "./registry"
export { defaultPreset } from "./default-preset"
export { jsonParser } from "./parsers/json-parser"
export { logParser } from "./parsers/log-parser"
export { stackTraceParser } from "./parsers/stack-trace-parser"
export { pathUrlParser } from "./parsers/path-url-parser"
export { pythonTracebackParser } from "./parsers/python-traceback-parser"
export { rustPanicParser } from "./parsers/rust-panic-parser"
export { anthropicErrorParser } from "./parsers/anthropic-error-parser"
export { ansiParser } from "./parsers/ansi-parser"
export { compileErrorParser } from "./parsers/compile-error-parser"
export { bashPreset } from "./presets/bash-preset"
export { httpPreset } from "./presets/http-preset"

import { registerDefaultPreset, registerToolPreset } from "./registry"
import { defaultPreset } from "./default-preset"
import { bashPreset } from "./presets/bash-preset"
import { httpPreset } from "./presets/http-preset"

registerDefaultPreset(defaultPreset)
registerToolPreset("tool-Bash", bashPreset)
registerToolPreset("bash", bashPreset)
registerToolPreset("tool-http", httpPreset)
registerToolPreset("http", httpPreset)
