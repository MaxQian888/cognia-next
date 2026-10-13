import Capacitor
import UIKit

/// Hands a sign-in link to the identity provider's own app (lib/oauth/app-handoff.ts).
///
/// The target is fixed here, never taken from the caller, and the link must be on that
/// target's Applink host. It opens as a universal link only: when the app is missing the
/// open fails instead of loading the page in Safari, and the caller falls back to its own
/// in-app browser.
@objc(CogniaAppHandoffPlugin)
public final class CogniaAppHandoffPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CogniaAppHandoffPlugin"
    public let jsName = "CogniaAppHandoff"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    private struct Target {
        /// Listed under LSApplicationQueriesSchemes so canOpenURL may ask about it.
        let scheme: String
        let host: String
    }

    private func target(named name: String?) -> Target? {
        switch name {
        case "feishu": return Target(scheme: "lark", host: "applink.feishu.cn")
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
        guard let raw = call.getString("url"),
              let url = URL(string: raw),
              url.scheme == "https",
              url.host == target.host else {
            call.reject("the link is not on the target's Applink host")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }
}
