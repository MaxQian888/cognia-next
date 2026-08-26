/**
 * @jest-environment jsdom
 *
 * Smoke test for the transports barrel — re-exports ConsoleTransport,
 * IndexedDBTransport, RemoteTransport, NativeTransport,
 * LangfuseTransport plus the retry-queue store factory and the Sentry /
 * Loggly transforms.
 */

import * as transports from "./index"

describe("transports barrel exports", () => {
  it("re-exports console transport class + factory", () => {
    expect(typeof transports.ConsoleTransport).toBe("function")
    expect(typeof transports.createConsoleTransport).toBe("function")
    const t = transports.createConsoleTransport()
    expect(t.name).toBe("console")
  })

  it("re-exports IndexedDB transport class + factory", () => {
    expect(typeof transports.IndexedDBTransport).toBe("function")
    expect(typeof transports.createIndexedDBTransport).toBe("function")
  })

  it("re-exports remote transport class + factory + transforms", () => {
    expect(typeof transports.RemoteTransport).toBe("function")
    expect(typeof transports.createRemoteTransport).toBe("function")
    expect(typeof transports.sentryTransform).toBe("function")
    expect(typeof transports.logglyTransform).toBe("function")
  })

  it("re-exports langfuse transport class + factory", () => {
    expect(typeof transports.LangfuseTransport).toBe("function")
    expect(typeof transports.createLangfuseTransport).toBe("function")
  })

  it("re-exports native transport class + factory", () => {
    expect(typeof transports.NativeTransport).toBe("function")
    expect(typeof transports.createNativeTransport).toBe("function")
  })

  it("re-exports the privacy-gated OTLP Logs transport", () => {
    expect(typeof transports.OtlpLogTransport).toBe("function")
    expect(typeof transports.createOtlpLogTransport).toBe("function")
  })

  it("re-exports remote retry queue store class + factory", () => {
    expect(typeof transports.IndexedDBRemoteRetryQueueStore).toBe("function")
    expect(typeof transports.createRemoteRetryQueueStore).toBe("function")
  })
})
