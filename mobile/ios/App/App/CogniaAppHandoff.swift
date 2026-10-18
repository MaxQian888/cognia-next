import Capacitor
import UIKit

/// Hands a link to one known app (lib/capacitor/app-handoff.ts): a sign-in link to the
/// identity provider's own app (lib/oauth/app-handoff.ts), or a remote desktop ID to
/// RustDesk (ADR-0234 Phase 5, lib/remote-desktop/launch.ts).
///
/// The target and its accepted link shape are fixed here, never taken from the caller.
/// Feishu links open as universal links only: when the app is missing the open fails
/// instead of loading the page in Safari, and the caller falls back to its own in-app
/// browser. RustDesk takes only `rustdesk://connection/new/<id>[@server][?key=]`, never
/// its `config` or `password` links, which change its settings.
@objc(CogniaAppHandoffPlugin)
public final class CogniaAppHandoffPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CogniaAppHandoffPlugin"
    public let jsName = "CogniaAppHandoff"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    /// The one RustDesk link form Cognia opens (cognia-remote-desktop `launch.rs`).
    static let rustdeskLink = try! NSRegularExpression(
        pattern: "^rustdesk://connection/new/[A-Za-z0-9][A-Za-z0-9_-]{5,31}"
            + "(?:@(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)(?::\\d{1,5})?)?"
            + "(?:\\?key=(?:%[0-9A-F]{2}|[A-Za-z0-9])+)?$"
    )

    private struct Target {
        /// Listed under LSApplicationQueriesSchemes so canOpenURL may ask about it.
        let scheme: String
        /// Feishu's Applink host; nil for a custom-scheme target.
        let host: String?
        let refusal: String

        func accepts(_ raw: String) -> URL? {
            guard let url = URL(string: raw) else { return nil }
            if let host {
                return url.scheme == "https" && url.host == host ? url : nil
            }
            let range = NSRange(raw.startIndex..., in: raw)
            let matches = raw.count <= 512
                && CogniaAppHandoffPlugin.rustdeskLink.firstMatch(in: raw, range: range) != nil
            return matches ? url : nil
        }
    }

    private func target(named name: String?) -> Target? {
        switch name {
        case "feishu":
            return Target(scheme: "lark", host: "applink.feishu.cn",
                          refusal: "the link is not on the target's Applink host")
        case "rustdesk":
            return Target(scheme: "rustdesk", host: nil,
                          refusal: "the link is not a RustDesk connect link")
        default: return nil
        }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        guard let target = target(named: call.getString("target")),
              let probe = URL(string: "\(target.scheme)://") else {
            call.reject("unknown handoff target")
            return
        }
        DispatchQueue.main.async {
            call.resolve(["available": UIApplication.shared.canOpenURL(probe)])
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let target = target(named: call.getString("target")) else {
            call.reject("unknown handoff target")
            return
        }
        guard let raw = call.getString("url"), let url = target.accepts(raw) else {
            call.reject(target.refusal)
            return
        }
        let options: [UIApplication.OpenExternalURLOptionsKey: Any] =
            target.host == nil ? [:] : [.universalLinksOnly: true]
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: options) { opened in
                call.resolve(["opened": opened])
            }
        }
    }
}
