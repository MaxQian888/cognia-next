package com.cognia.mobile;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;

@CapacitorPlugin(name = "CogniaDeviceServices")
public class CogniaDeviceServicesPlugin extends Plugin {
    @PluginMethod
    public void getStatus(PluginCall call) {
        // Query only: never open a repair/install dialog on devices without GMS.
        int status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
        JSObject result = new JSObject();
        result.put("available", status == ConnectionResult.SUCCESS);
        result.put("status", status);
        call.resolve(result);
    }
    @PluginMethod
    public void getOrientationLockSupport(PluginCall call) {
        boolean restricted = Build.VERSION.SDK_INT >= 36
            && getContext().getApplicationInfo().targetSdkVersion >= 36
            && getContext().getResources().getConfiguration().smallestScreenWidthDp >= 600;
        JSObject result = new JSObject();
        result.put("supported", !restricted);
        call.resolve(result);
    }

}
