package com.cognia.mobile;

import static org.junit.Assert.*;

import com.getcapacitor.JSObject;
import org.junit.Test;

public class CogniaHuaweiPushPayloadTest {
    @Test
    public void normalizesDataOnlyMessageAndPreservesSessionRouting() {
        JSObject data = CogniaHuaweiPushPayload.parseData(
            "{\"sessionId\":\"session-1\",\"title\":\"Done\",\"body\":\"Ready\",\"nested\":{\"value\":1}}"
        );
        JSObject message = CogniaHuaweiPushPayload.notification("msg-1", null, null, data);
        assertEquals("msg-1", message.optString("id"));
        assertEquals("Done", message.optString("title"));
        assertEquals("Ready", message.optString("body"));
        assertEquals("session-1", message.optJSONObject("data").optString("sessionId"));
        assertEquals(1, message.optJSONObject("data").optJSONObject("nested").optInt("value"));
    }

    @Test
    public void explicitNotificationTextTakesPrecedenceOverDataText() {
        JSObject message = CogniaHuaweiPushPayload.notification("id", "Native title", "Native body",
            CogniaHuaweiPushPayload.parseData("{\"title\":\"Data title\",\"body\":\"Data body\"}"));
        assertEquals("Native title", message.optString("title"));
        assertEquals("Native body", message.optString("body"));
    }

    @Test
    public void malformedEmptyAndNonObjectPayloadsAreSafe() {
        for (String raw : new String[] { null, "", "not-json", "[]", "null" }) {
            assertEquals(0, CogniaHuaweiPushPayload.parseData(raw).length());
        }
    }

    @Test
    public void missingNotificationFieldsHaveStableEmptyValues() {
        JSObject message = CogniaHuaweiPushPayload.notification(null, null, null, new JSObject());
        assertEquals("", message.optString("id"));
        assertEquals("", message.optString("title"));
        assertEquals("", message.optString("body"));
        assertEquals(0, message.optJSONObject("data").length());
    }
}
