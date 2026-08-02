package com.cognia.mobile;

import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;

@CapacitorPlugin(name = "CogniaCrash")
public final class CogniaCrashPlugin extends Plugin {
    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("apiLevel", Build.VERSION.SDK_INT);
        result.put("javaCrash", "supported");
        result.put("nativeCrash", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? "exit-info" : "unavailable");
        result.put("anr", CogniaCrashStore.supportsApplicationExitInfo() ? "exit-info" : "unavailable");
        result.put("applicationExitInfo", CogniaCrashStore.supportsApplicationExitInfo());
        result.put("minidump", "unavailable");
        result.put("retentionDays", 30);
        result.put("maxIncidents", CogniaCrashPolicy.MAX_INCIDENTS);
        call.resolve(result);
    }

    @PluginMethod
    public void listPending(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("incidents", store().list());
            call.resolve(result);
        } catch (IOException exception) {
            call.reject("Unable to list crash reports", "CRASH_LIST_FAILED", exception);
        }
    }

    @PluginMethod
    public void readPending(PluginCall call) {
        String incidentId = call.getString("incidentId");
        if (incidentId == null || incidentId.isBlank()) {
            call.reject("incidentId is required", "CRASH_INVALID_ID");
            return;
        }
        try {
            JSObject result = new JSObject();
            result.put("incident", store().read(incidentId));
            call.resolve(result);
        } catch (IOException exception) {
            call.reject("Unable to read crash report", "CRASH_READ_FAILED", exception);
        }
    }

    @PluginMethod
    public void deletePending(PluginCall call) {
        String incidentId = call.getString("incidentId");
        if (incidentId == null || incidentId.isBlank()) {
            call.reject("incidentId is required", "CRASH_INVALID_ID");
            return;
        }
        try {
            store().delete(incidentId);
            call.resolve();
        } catch (IOException exception) {
            call.reject("Unable to delete crash report", "CRASH_DELETE_FAILED", exception);
        }
    }

    @PluginMethod
    public void markReceipt(PluginCall call) {
        String incidentId = call.getString("incidentId");
        String receiptCode = call.getString("receiptCode");
        String state = call.getString("state", "accepted");
        if (incidentId == null || incidentId.isBlank() || receiptCode == null || receiptCode.isBlank()) {
            call.reject("incidentId and receiptCode are required", "CRASH_INVALID_RECEIPT");
            return;
        }
        try {
            store().markReceipt(incidentId, receiptCode, state);
            call.resolve();
        } catch (IOException exception) {
            call.reject("Unable to update crash receipt", "CRASH_RECEIPT_FAILED", exception);
        }
    }

    private CogniaCrashStore store() {
        return new CogniaCrashStore(getContext());
    }
}
