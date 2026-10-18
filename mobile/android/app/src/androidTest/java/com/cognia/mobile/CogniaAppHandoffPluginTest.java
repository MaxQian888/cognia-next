package com.cognia.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.junit.Test;

public class CogniaAppHandoffPluginTest {
    private static final class Outcome {
        JSObject resolved;
        String rejected;
    }

    private static CogniaAppHandoffPlugin plugin(Context context) {
        return new CogniaAppHandoffPlugin() {
            @Override
            public Context getContext() {
                return context;
            }
        };
    }

    private static PluginCall call(String method, JSObject data, Outcome outcome) {
        return new PluginCall(null, "CogniaAppHandoff", "test", method, data) {
            @Override
            public void resolve(JSObject result) {
                outcome.resolved = result;
            }

            @Override
            public void reject(String message) {
                outcome.rejected = message;
            }
        };
    }

    @Test
    public void availabilityMatchesWhetherTheFeishuPackageTakesItsApplinks() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Outcome outcome = new Outcome();
        JSObject data = new JSObject();
        data.put("target", "feishu");

        plugin(context).isAvailable(call("isAvailable", data, outcome));

        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://applink.feishu.cn/"));
        probe.addCategory(Intent.CATEGORY_BROWSABLE);
        probe.setPackage("com.ss.android.lark");
        boolean installed = probe.resolveActivity(context.getPackageManager()) != null;
        assertNotNull(outcome.resolved);
        assertEquals(installed, outcome.resolved.getBool("available"));
        assertEquals("CogniaAppHandoff",
            CogniaAppHandoffPlugin.class.getAnnotation(CapacitorPlugin.class).name());
    }

    @Test
    public void refusesUnknownTargetsAndLinksOffTheTargetHost() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

        Outcome unknown = new Outcome();
        JSObject other = new JSObject();
        other.put("target", "wechat");
        plugin(context).isAvailable(call("isAvailable", other, unknown));
        assertEquals("unknown handoff target", unknown.rejected);
        assertNull(unknown.resolved);

        for (String url : new String[] {
            "https://evil.example/client/web_url/open",
            "http://applink.feishu.cn/client/web_url/open",
            "intent://applink.feishu.cn/#Intent;end",
        }) {
            Outcome offHost = new Outcome();
            JSObject data = new JSObject();
            data.put("target", "feishu");
            data.put("url", url);
            plugin(context).open(call("open", data, offHost));
            assertEquals(url, "the link is not on the target's Applink host", offHost.rejected);
            assertNull(url, offHost.resolved);
        }
    }

    @Test
    public void availabilityMatchesWhetherRustDeskTakesItsLinks() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Outcome outcome = new Outcome();
        JSObject data = new JSObject();
        data.put("target", "rustdesk");

        plugin(context).isAvailable(call("isAvailable", data, outcome));

        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("rustdesk://connection/new/000000000"));
        probe.addCategory(Intent.CATEGORY_BROWSABLE);
        probe.setPackage("com.carriez.flutter_hbb");
        boolean installed = probe.resolveActivity(context.getPackageManager()) != null;
        assertNotNull(outcome.resolved);
        assertEquals(installed, outcome.resolved.getBool("available"));
    }

    @Test
    public void rustDeskTakesOnlyItsConnectLink() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (String url : new String[] {
            "rustdesk://123456789",
            "rustdesk://config/abc",
            "rustdesk://password/abc",
            "rustdesk://connection/new/123456789?password=x",
            "rustdesk://connection/new/123456789?key=a&password=x",
            "https://applink.feishu.cn/client/web_url/open",
        }) {
            Outcome refused = new Outcome();
            JSObject data = new JSObject();
            data.put("target", "rustdesk");
            data.put("url", url);
            plugin(context).open(call("open", data, refused));
            assertEquals(url, "the link is not a RustDesk connect link", refused.rejected);
            assertNull(url, refused.resolved);
        }
        String[] accepted = {
            "rustdesk://connection/new/123456789",
            "rustdesk://connection/new/123456789@rd.example.com:21116?key=Ab%2B%2F%3D",
            "rustdesk://connection/new/Office_PC-2@[fd00::1]",
        };
        for (String url : accepted) {
            assertEquals(url, true, CogniaAppHandoffPlugin.RUSTDESK_LINK.matcher(url).matches());
        }
    }
}
