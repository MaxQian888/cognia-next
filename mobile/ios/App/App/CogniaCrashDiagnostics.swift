import Capacitor
import CryptoKit
import Foundation
import KSCrash
import MetricKit
import UIKit

private enum CogniaCrashError: Error {
    case invalidIncidentID
    case reportNotFound
    case invalidReport
}

private final class CogniaCrashStore {
    static let shared = CogniaCrashStore()

    private let fileManager = FileManager.default
    private let queue = DispatchQueue(label: "com.cognia.mobile.crash-store")
    private let maxIncidents = 50
    private let maxTotalBytes: Int64 = 1024 * 1024 * 1024
    private let maxAge: TimeInterval = 30 * 24 * 60 * 60
    private let reportSuffix = ".json"
    private let reportsURL: URL
    let kscrashURL: URL

    private init() {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        let diagnostics = applicationSupport.appendingPathComponent("Diagnostics", isDirectory: true)
        reportsURL = diagnostics.appendingPathComponent("CrashReports", isDirectory: true)
        kscrashURL = diagnostics.appendingPathComponent("KSCrash", isDirectory: true)
        try? createProtectedDirectory(diagnostics)
        try? createProtectedDirectory(reportsURL)
        try? createProtectedDirectory(kscrashURL)
    }

    func persist(source: String, payload: Any) throws -> String {
        try queue.sync {
            let redactedPayload = try redactJSONObject(payload)
            let payloadData = try JSONSerialization.data(withJSONObject: redactedPayload, options: [.sortedKeys])
            let incidentID = stableID(source: source, data: payloadData)
            let target = try reportURL(for: incidentID)
            guard !fileManager.fileExists(atPath: target.path) else { return incidentID }

            let envelope: [String: Any] = [
                "schemaVersion": "cognia-mobile-crash-v1",
                "incidentId": incidentID,
                "source": source,
                "detectedAt": Int64(Date().timeIntervalSince1970 * 1000),
                "state": "detected",
                "redactionVersion": "mobile-v1",
                "payload": redactedPayload,
            ]
            let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
            try data.write(to: target, options: [.atomic, .completeFileProtectionUnlessOpen])
            try excludeFromBackup(target)
            pruneLocked()
            return incidentID
        }
    }

    func list() throws -> [[String: Any]] {
        try queue.sync {
            try sortedReportsLocked().compactMap { url in
                guard let envelope = try? readLocked(url),
                      let values = try? url.resourceValues(forKeys: [.fileSizeKey]) else {
                    return nil
                }
                var summary: [String: Any] = [
                    "incidentId": envelope["incidentId"] as? String ?? "",
                    "source": envelope["source"] as? String ?? "",
                    "detectedAt": envelope["detectedAt"] as? NSNumber ?? 0,
                    "state": envelope["state"] as? String ?? "detected",
                    "sizeBytes": values.fileSize ?? 0,
                ]
                if let receiptCode = envelope["receiptCode"] as? String {
                    summary["receiptCode"] = receiptCode
                }
                return summary
            }
        }
    }

    func read(incidentID: String) throws -> [String: Any] {
        try queue.sync {
            let url = try reportURL(for: incidentID)
            guard fileManager.fileExists(atPath: url.path) else { throw CogniaCrashError.reportNotFound }
            return try readLocked(url)
        }
    }

    func delete(incidentID: String) throws {
        try queue.sync {
            let url = try reportURL(for: incidentID)
            guard fileManager.fileExists(atPath: url.path) else { return }
            try fileManager.removeItem(at: url)
        }
    }

    func markReceipt(incidentID: String, receiptCode: String, state: String) throws {
        try queue.sync {
            let url = try reportURL(for: incidentID)
            guard fileManager.fileExists(atPath: url.path) else { throw CogniaCrashError.reportNotFound }
            var envelope = try readLocked(url)
            envelope["receiptCode"] = redact(receiptCode)
            envelope["state"] = state
            envelope["receiptUpdatedAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
            try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
            try excludeFromBackup(url)
        }
    }

    private func createProtectedDirectory(_ url: URL) throws {
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        try excludeFromBackup(url)
    }

    private func excludeFromBackup(_ url: URL) throws {
        var mutableURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
    }

    private func stableID(source: String, data: Data) -> String {
        var input = Data(source.utf8)
        input.append(0x0A)
        input.append(data)
        return SHA256.hash(data: input).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private func reportURL(for incidentID: String) throws -> URL {
        let allowed = incidentID.range(of: "^[A-Za-z0-9._-]{1,80}$", options: .regularExpression) != nil
        guard allowed, incidentID != ".", incidentID != ".." else {
            throw CogniaCrashError.invalidIncidentID
        }
        return reportsURL.appendingPathComponent(incidentID + reportSuffix, isDirectory: false)
    }

    private func readLocked(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CogniaCrashError.invalidReport
        }
        return envelope
    }

    private func sortedReportsLocked() throws -> [URL] {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey]
        return try fileManager.contentsOfDirectory(
            at: reportsURL,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ).filter { url in
            url.pathExtension == "json"
        }.sorted { lhs, rhs in
            let left = try? lhs.resourceValues(forKeys: keys).contentModificationDate
            let right = try? rhs.resourceValues(forKeys: keys).contentModificationDate
            return (left ?? .distantPast) > (right ?? .distantPast)
        }
    }

    private func pruneLocked() {
        guard let reports = try? sortedReportsLocked() else { return }
        let now = Date()
        var retainedCount = 0
        var retainedBytes: Int64 = 0
        for report in reports {
            let values = try? report.resourceValues(forKeys: [
                .fileSizeKey,
                .contentModificationDateKey,
            ])
            let size = Int64(values?.fileSize ?? 0)
            let modified = values?.contentModificationDate ?? .distantPast
            let expired = now.timeIntervalSince(modified) > maxAge
            let overCount = retainedCount >= maxIncidents
            let overBytes = retainedBytes + size > maxTotalBytes
            if expired || overCount || overBytes {
                try? fileManager.removeItem(at: report)
            } else {
                retainedCount += 1
                retainedBytes += size
            }
        }
    }

    private func redactJSONObject(_ payload: Any) throws -> Any {
        let data: Data
        if JSONSerialization.isValidJSONObject(payload) {
            data = try JSONSerialization.data(withJSONObject: payload)
        } else if let text = payload as? String {
            data = try JSONSerialization.data(withJSONObject: ["value": text])
        } else {
            data = try JSONSerialization.data(withJSONObject: ["value": String(describing: payload)])
        }
        guard let json = String(data: data, encoding: .utf8),
              let redactedData = redact(json).data(using: .utf8) else {
            throw CogniaCrashError.invalidReport
        }
        return try JSONSerialization.jsonObject(with: redactedData)
    }

    private func redact(_ value: String) -> String {
        let rules: [(String, String)] = [
            ("(?i)\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/-]+=*", "[REDACTED_AUTHORIZATION]"),
            ("(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}(?![A-Z0-9._%+-])", "[REDACTED_EMAIL]"),
            ("(?i)\\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\\b\\s*[:=]\\s*[^\\s,;\\\"']+", "$1=[REDACTED_CREDENTIAL]"),
            ("/(Users|home)/[^/\\s]+/", "/$1/[REDACTED_USER]/"),
        ]
        return rules.reduce(value) { result, rule in
            guard let expression = try? NSRegularExpression(pattern: rule.0) else { return result }
            let range = NSRange(result.startIndex..<result.endIndex, in: result)
            return expression.stringByReplacingMatches(in: result, range: range, withTemplate: rule.1)
        }
    }
}

final class CogniaCrashCollector: NSObject, MXMetricManagerSubscriber {
    static let shared = CogniaCrashCollector()

    private(set) var kscrashHealthy = false
    private var installed = false

    func install() {
        guard !installed else { return }
        installed = true

        let configuration = KSCrashConfiguration()
        configuration.installPath = CogniaCrashStore.shared.kscrashURL.path
        configuration.monitors = .productionSafeMinimal
        configuration.deadlockWatchdogInterval = 0
        configuration.enableMemoryIntrospection = false
        configuration.addConsoleLogToReport = false
        do {
            kscrashHealthy = try KSCrash.shared.install(with: configuration)
            migrateKSCrashReports()
        } catch {
            kscrashHealthy = false
        }

        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            guard let object = try? JSONSerialization.jsonObject(with: payload.jsonRepresentation()) else {
                continue
            }
            _ = try? CogniaCrashStore.shared.persist(source: "ios-metrickit", payload: object)
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        // Routine MetricKit metrics are handled by structured metric events; this collector retains diagnostics only.
    }

    private func migrateKSCrashReports() {
        guard let reportStore = KSCrash.shared.reportStore else { return }
        for reportID in reportStore.reportIDs {
            guard let report = reportStore.report(for: reportID.int64Value) else { continue }
            if (try? CogniaCrashStore.shared.persist(source: "ios-kscrash", payload: report.value)) != nil {
                reportStore.deleteReport(with: reportID.int64Value)
            }
        }
    }
}

@objc(CogniaCrashPlugin)
public final class CogniaCrashPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CogniaCrashPlugin"
    public let jsName = "CogniaCrash"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markReceipt", returnType: CAPPluginReturnPromise),
    ]

    @objc func capabilities(_ call: CAPPluginCall) {
        let operatingSystem = ProcessInfo.processInfo.operatingSystemVersion
        call.resolve([
            "platform": "ios",
            "nativeCrash": CogniaCrashCollector.shared.kscrashHealthy ? "supported" : "unavailable",
            "anr": "unavailable",
            "metricKit": true,
            "osVersion": operatingSystem.majorVersion,
            "retentionDays": 30,
            "maxIncidents": 50,
        ])
    }

    @objc func listPending(_ call: CAPPluginCall) {
        do {
            call.resolve(["incidents": try CogniaCrashStore.shared.list()])
        } catch {
            call.reject("Unable to list crash reports", "CRASH_LIST_FAILED", error)
        }
    }

    @objc func readPending(_ call: CAPPluginCall) {
        guard let incidentID = call.getString("incidentId"), !incidentID.isEmpty else {
            call.reject("incidentId is required", "CRASH_INVALID_ID")
            return
        }
        do {
            call.resolve(["incident": try CogniaCrashStore.shared.read(incidentID: incidentID)])
        } catch {
            call.reject("Unable to read crash report", "CRASH_READ_FAILED", error)
        }
    }

    @objc func deletePending(_ call: CAPPluginCall) {
        guard let incidentID = call.getString("incidentId"), !incidentID.isEmpty else {
            call.reject("incidentId is required", "CRASH_INVALID_ID")
            return
        }
        do {
            try CogniaCrashStore.shared.delete(incidentID: incidentID)
            call.resolve()
        } catch {
            call.reject("Unable to delete crash report", "CRASH_DELETE_FAILED", error)
        }
    }

    @objc func markReceipt(_ call: CAPPluginCall) {
        guard let incidentID = call.getString("incidentId"), !incidentID.isEmpty,
              let receiptCode = call.getString("receiptCode"), !receiptCode.isEmpty else {
            call.reject("incidentId and receiptCode are required", "CRASH_INVALID_RECEIPT")
            return
        }
        do {
            try CogniaCrashStore.shared.markReceipt(
                incidentID: incidentID,
                receiptCode: receiptCode,
                state: call.getString("state") ?? "accepted"
            )
            call.resolve()
        } catch {
            call.reject("Unable to update crash receipt", "CRASH_RECEIPT_FAILED", error)
        }
    }
}

@objc(CogniaBridgeViewController)
public final class CogniaBridgeViewController: CAPBridgeViewController {
    public override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CogniaCrashPlugin())
    }
}
