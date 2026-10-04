package com.cognia.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import org.junit.Test;

public class CogniaDeviceServicesPluginTest {
    @Test
    public void bridgeReportsTheDeviceStatusWithoutRequestingResolution() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CogniaDeviceServicesPlugin plugin = new CogniaDeviceServicesPlugin() {
            @Override
            public Context getContext() {
                return context;
            }
        };
        JSObject[] response = new JSObject[1];
        PluginCall call = new PluginCall(null, "CogniaDeviceServices", "test", "getStatus", new JSObject()) {
            @Override
            public void resolve(JSObject result) {
                response[0] = result;
            }
        };

        plugin.getStatus(call);

        int status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context);
        assertNotNull(response[0]);
        assertEquals(status, response[0].getInteger("status").intValue());
        assertEquals(status == ConnectionResult.SUCCESS, response[0].getBool("available"));
        assertEquals("CogniaDeviceServices",
            CogniaDeviceServicesPlugin.class.getAnnotation(CapacitorPlugin.class).name());
    }
}
