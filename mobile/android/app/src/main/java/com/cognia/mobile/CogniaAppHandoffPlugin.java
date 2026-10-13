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

/**
 * Hands a sign-in link to the identity provider's own app (lib/oauth/app-handoff.ts).
 *
 * The package is fixed here per target, never taken from the caller, and the link must
 * be on that target's Applink host. Opening it in the package is the point: on devices
 * without Google services the target's App Link verification fails ("legacy_failure"),
 * so a bare VIEW intent shows a chooser that offers the browser as well.
 */
@CapacitorPlugin(name = "CogniaAppHandoff")
public class CogniaAppHandoffPlugin extends Plugin {
    private static final class Target {
        final String packageName;
        final String host;

        Target(String packageName, String host) {
            this.packageName = packageName;
            this.host = host;
        }
    }

    /** Feishu (China); Lark's international app is a different package and host. */
    private static Target targetFor(String name) {
        if ("feishu".equals(name)) return new Target("com.ss.android.lark", "applink.feishu.cn");
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
        Intent probe = viewIntent(target, Uri.parse("https://" + target.host + "/"));
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
        if (uri == null || !"https".equals(uri.getScheme()) || !target.host.equals(uri.getHost())) {
            call.reject("the link is not on the target's Applink host");
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
