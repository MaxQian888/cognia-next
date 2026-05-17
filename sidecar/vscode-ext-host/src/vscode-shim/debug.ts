/**
 * `vscode.debug` — Tier 4. cognia has no DAP viewport, so every API
 * surface throws `NotSupportedError`. Static contribution points
 * (`contributes.debuggers`, `contributes.breakpoints`) are still honored
 * at install time so extension manifest validation passes.
 */

import { Disposable, EventEmitter, NotSupportedError } from "./types"

export function createDebugNamespace() {
  const dummyEmitter = new EventEmitter<unknown>()
  return {
    get activeDebugSession() {
      return undefined
    },
    get activeDebugConsole() {
      return {
        append: () => {},
        appendLine: () => {},
      }
    },
    get breakpoints() {
      return [] as unknown[]
    },
    registerDebugAdapterDescriptorFactory(_debugType: string, _factory: unknown): Disposable {
      throw new NotSupportedError("debug.registerDebugAdapterDescriptorFactory")
    },
    registerDebugConfigurationProvider(_debugType: string, _provider: unknown): Disposable {
      throw new NotSupportedError("debug.registerDebugConfigurationProvider")
    },
    registerDebugAdapterTrackerFactory(_debugType: string, _factory: unknown): Disposable {
      throw new NotSupportedError("debug.registerDebugAdapterTrackerFactory")
    },
    startDebugging(): Promise<boolean> {
      throw new NotSupportedError("debug.startDebugging")
    },
    stopDebugging(): Promise<void> {
      throw new NotSupportedError("debug.stopDebugging")
    },
    addBreakpoints(_breakpoints: unknown[]): void {
      throw new NotSupportedError("debug.addBreakpoints")
    },
    removeBreakpoints(_breakpoints: unknown[]): void {
      throw new NotSupportedError("debug.removeBreakpoints")
    },
    onDidStartDebugSession: dummyEmitter.event,
    onDidChangeActiveDebugSession: dummyEmitter.event,
    onDidTerminateDebugSession: dummyEmitter.event,
    onDidReceiveDebugSessionCustomEvent: dummyEmitter.event,
    onDidChangeBreakpoints: dummyEmitter.event,
  }
}
