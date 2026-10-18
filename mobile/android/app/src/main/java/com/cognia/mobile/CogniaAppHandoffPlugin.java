package com.cognia.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.regex.Pattern;

/**
 * Hands a link to one known app (lib/capacitor/app-handoff.ts): a sign-in link to the
 * identity provider's own app (lib/oauth/app-handoff.ts), or a remote desktop ID to
 * RustDesk (ADR-0234 Phase 5, lib/remote-desktop/launch.ts).
 *
 * The package and the accepted link shape are fixed here per target, never taken from
 * the caller. Opening the link in the package is the point: on devices without Google
 * services a target's App Link verification fails ("legacy_failure"), so a bare VIEW
 * intent shows a chooser that offers the browser as well. RustDesk takes only
 * `rustdesk://connection/new/<id>[@server][?key=]`, never its `config` or `password`
 * links, which change its settings.
 */
@CapacitorPlugin(name = "CogniaAppHandoff")
public class CogniaAppHandoffPlugin extends Plugin {
    /** The one RustDesk link form Cognia opens (cognia-remote-desktop `launch.rs`). */
    static final Pattern RUSTDESK_LINK = Pattern.compile(
        "^rustdesk://connection/new/[A-Za-z0-9][A-Za-z0-9_-]{5,31}"
            + "(?:@(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)(?::\\d{1,5})?)?"
            + "(?:\\?key=(?:%[0-9A-F]{2}|[A-Za-z0-9])+)?$");

    private static final class Target {
        final String packageName;
        /** A link the package takes, to ask whether it is installed. */
        final String probe;
        /** Feishu's Applink host; null for a custom-scheme target. */
        final String host;
        final String refusal;

        Target(String packageName, String probe, String host, String refusal) {
            this.packageName = packageName;
            this.probe = probe;
            this.host = host;
            this.refusal = refusal;
        }

        boolean accepts(String url, Uri uri) {
            if (host != null) return "https".equals(uri.getScheme()) && host.equals(uri.getHost());
            return url.length() <= 512 && RUSTDESK_LINK.matcher(url).matches();
        }
    }

    /** Feishu (China); Lark's international app is a different package and host. */
    private static Target targetFor(String name) {
        if ("feishu".equals(name)) {
            return new Target(
                "com.ss.android.lark",
                "https://applink.feishu.cn/",
                "applink.feishu.cn",
                "the link is not on the target's Applink host");
        }
        if ("rustdesk".equals(name)) {
            return new Target(
                "com.carriez.flutter_hbb",
                "rustdesk://connection/new/000000000",
                null,
                "the link is not a RustDesk connect link");
        }
        return null;
    }

    private static Intent viewIntent(Target target, Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setPackage(target.packageName);
        return intent;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        Target target = targetFor(call.getString("target"));
        if (target == null) {
            call.reject("unknown handoff target");
            return;
        }
        // Package visibility for this query is declared in the manifest's <queries>.
        PackageManager packages = getContext().getPackageManager();
        Intent probe = viewIntent(target, Uri.parse(target.probe));
        JSObject result = new JSObject();
        result.put("available", probe.resolveActivity(packages) != null);
        call.resolve(result);
    }

    @PluginMethod
    public void open(PluginCall call) {
        Target target = targetFor(call.getString("target"));
        if (target == null) {
            call.reject("unknown handoff target");
            return;
        }
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || !target.accepts(url, uri)) {
            call.reject(target.refusal);
            return;
        }
        JSObject result = new JSObject();
        try {
            getActivity().startActivity(viewIntent(target, uri));
            result.put("opened", true);
        } catch (ActivityNotFoundException missing) {
            result.put("opened", false);
        }
        call.resolve(result);
    }
}
