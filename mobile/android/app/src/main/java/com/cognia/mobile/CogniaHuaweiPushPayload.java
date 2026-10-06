package com.cognia.mobile;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import org.json.JSONException;

/** Normalize both SDK callbacks and notification taps to the Capacitor shape. */
final class CogniaHuaweiPushPayload {
    static final String ACTION = "com.cognia.mobile.HUAWEI_PUSH";

    private CogniaHuaweiPushPayload() {}

    static JSObject notification(String id, String title, String body, JSObject data) {
        JSObject result = new JSObject();
        result.put("id", id == null ? "" : id);
        result.put("title", title == null || title.isEmpty() ? data.optString("title", "") : title);
        result.put("body", body == null || body.isEmpty() ? data.optString("body", "") : body);
        result.put("data", data);
        return result;
    }

    static JSObject parseData(String raw) {
        if (raw == null || raw.isEmpty()) return new JSObject();
        try {
            return new JSObject(raw);
        } catch (JSONException malformed) {
            return new JSObject();
        }
    }

    static JSObject fromIntent(Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction()) || intent.getBooleanExtra("cogniaHuaweiPushHandled", false)) return null;
        Bundle extras = intent.getExtras();
        JSObject data = parseData(intent.getStringExtra("data"));
        if (extras != null) {
            // HMS delivers notification data as intent extras. Local data-only
            // notifications keep the same payload as a JSON string in `data`.
            for (String key : extras.keySet()) {
                if (!key.equals("data") && !key.equals("cogniaHuaweiPushHandled")) {
                    Object value = extras.get(key);
                    if (value instanceof String || value instanceof Number || value instanceof Boolean) data.put(key, value);
                }
            }
        }
        return notification(data.optString("msgId", data.optString("id", "")), null, null, data);
    }
}
