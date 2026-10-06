package com.cognia.mobile;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;

public class CogniaHuaweiPushPluginTest {
    @Test
    public void tapPreservesRoutingDataAndNotificationText() {
        Intent intent = new Intent(CogniaHuaweiPushPayload.ACTION)
            .putExtra("data", "{\"sessionId\":\"session-1\",\"title\":\"Finished\",\"body\":\"Ready\"}")
            .putExtra("msgId", "huawei-message-1");
        JSObject notification = CogniaHuaweiPushPayload.fromIntent(intent);
        assertNotNull(notification);
        assertEquals("huawei-message-1", notification.optString("id"));
        assertEquals("Finished", notification.optString("title"));
        assertEquals("Ready", notification.optString("body"));
        assertEquals("session-1", notification.optJSONObject("data").optString("sessionId"));
    }

    @Test
    public void flatHmsIntentExtrasArePreserved() {
        Intent intent = new Intent(CogniaHuaweiPushPayload.ACTION)
            .putExtra("sessionId", "session-2").putExtra("title", "Done").putExtra("body", "Result");
        JSObject notification = CogniaHuaweiPushPayload.fromIntent(intent);
        assertEquals("Done", notification.optString("title"));
        assertEquals("session-2", notification.optJSONObject("data").optString("sessionId"));
    }

    @Test
    public void unrelatedAndConsumedIntentsDoNotEmitPushActions() {
        assertNull(CogniaHuaweiPushPayload.fromIntent(null));
        assertNull(CogniaHuaweiPushPayload.fromIntent(new Intent(Intent.ACTION_VIEW)));
        assertNull(CogniaHuaweiPushPayload.fromIntent(new Intent(CogniaHuaweiPushPayload.ACTION)
            .putExtra("cogniaHuaweiPushHandled", true)));
    }

    @Test
    public void malformedDataDoesNotCrashNotificationDelivery() {
        assertEquals(0, CogniaHuaweiPushPayload.parseData("not-json").length());
        JSObject notification = CogniaHuaweiPushPayload.notification("id", null, null,
            CogniaHuaweiPushPayload.parseData("{\"title\":\"Fallback\",\"body\":\"Text\"}"));
        assertEquals("Fallback", notification.optString("title"));
        assertEquals("Text", notification.optString("body"));
    }

    @Test
    public void unconfiguredBuildRejectsRegistrationWithoutSdkNetworkCalls() {
        if (BuildConfig.HUAWEI_PUSH_CONFIGURED) return;
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CogniaHuaweiPushPlugin plugin = new CogniaHuaweiPushPlugin() {
            @Override public Context getContext() { return context; }
        };
        String[] rejectedCode = new String[1];
        PluginCall call = new PluginCall(null, "CogniaHuaweiPush", "test", "register", new JSObject()) {
            @Override public void reject(String message, String code) { rejectedCode[0] = code; }
        };
        plugin.register(call);
        assertEquals("PUSH_NOT_CONFIGURED", rejectedCode[0]);
    }
}
