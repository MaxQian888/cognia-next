package com.cognia.mobile;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

final class CogniaCrashStore {
    private static final String SCHEMA_VERSION = "cognia-mobile-crash-v1";
    private static final String REPORT_SUFFIX = ".json";
    private static final String EXIT_WATERMARK = ".exit-watermark";

    private final File reportDirectory;

    CogniaCrashStore(Context context) {
        reportDirectory = new File(context.getNoBackupFilesDir(), "diagnostics/crash-reports");
    }

    synchronized String persist(String source, String rawPayload) throws IOException {
        ensureDirectory();
        String redacted = CogniaCrashPolicy.redact(rawPayload);
        String incidentId = CogniaCrashPolicy.stableId(source, redacted);
        File target = reportFile(incidentId);
        if (target.isFile()) {
            return incidentId;
        }

        JSONObject envelope = new JSONObject();
        try {
            envelope.put("schemaVersion", SCHEMA_VERSION);
            envelope.put("incidentId", incidentId);
            envelope.put("source", source);
            envelope.put("detectedAt", System.currentTimeMillis());
            envelope.put("state", "detected");
            envelope.put("redactionVersion", "mobile-v1");
            envelope.put("payload", parsePayload(redacted));
        } catch (JSONException exception) {
            throw new IOException("Unable to construct crash envelope", exception);
        }
        writeAtomically(target, envelope.toString());
        prune();
        return incidentId;
    }

    synchronized JSONArray list() throws IOException {
        ensureDirectory();
        JSONArray incidents = new JSONArray();
        for (File report : sortedReports()) {
            try {
                JSONObject envelope = readEnvelope(report);
                JSONObject summary = new JSONObject();
                summary.put("incidentId", envelope.optString("incidentId"));
                summary.put("source", envelope.optString("source"));
                summary.put("detectedAt", envelope.optLong("detectedAt"));
                summary.put("state", envelope.optString("state", "detected"));
                summary.put("receiptCode", envelope.optString("receiptCode", null));
                summary.put("sizeBytes", report.length());
                incidents.put(summary);
            } catch (JSONException ignored) {
                // A partially written or externally corrupted report is omitted from UI but retained for doctor/export.
            }
        }
        return incidents;
    }

    synchronized JSONObject read(String incidentId) throws IOException {
        File report = reportFile(incidentId);
        if (!report.isFile()) {
            throw new IOException("Crash report not found");
        }
        return readEnvelope(report);
    }

    synchronized void delete(String incidentId) throws IOException {
        File report = reportFile(incidentId);
        if (report.exists() && !report.delete()) {
            throw new IOException("Unable to delete crash report");
        }
    }

    synchronized void markReceipt(String incidentId, String receiptCode, String state) throws IOException {
        File report = reportFile(incidentId);
        if (!report.isFile()) {
            throw new IOException("Crash report not found");
        }
        JSONObject envelope = readEnvelope(report);
        try {
            envelope.put("receiptCode", CogniaCrashPolicy.redact(receiptCode));
            envelope.put("state", state);
            envelope.put("receiptUpdatedAt", System.currentTimeMillis());
        } catch (JSONException exception) {
            throw new IOException("Unable to update receipt", exception);
        }
        writeAtomically(report, envelope.toString());
    }

    void collectApplicationExitInfo(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }
        ActivityManager manager = context.getSystemService(ActivityManager.class);
        if (manager == null) {
            return;
        }
        long watermark = readExitWatermark();
        long newest = watermark;
        List<ApplicationExitInfo> exits = manager.getHistoricalProcessExitReasons(
            context.getPackageName(),
            0,
            CogniaCrashPolicy.MAX_EXIT_RECORDS
        );
        for (ApplicationExitInfo info : exits) {
            newest = Math.max(newest, info.getTimestamp());
            if (info.getTimestamp() <= watermark || !isDiagnosticExit(info.getReason())) {
                continue;
            }
            try {
                persist("android-application-exit", serializeExit(info).toString());
            } catch (IOException | JSONException ignored) {
                // Collection is best effort; the next launch retries because the watermark is not advanced here.
                return;
            }
        }
        if (newest > watermark) {
            writeExitWatermark(newest);
        }
    }

    static boolean supportsApplicationExitInfo() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
    }

    private static boolean isDiagnosticExit(int reason) {
        return reason == ApplicationExitInfo.REASON_ANR
            || reason == ApplicationExitInfo.REASON_CRASH
            || reason == ApplicationExitInfo.REASON_CRASH_NATIVE
            || reason == ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE
            || reason == ApplicationExitInfo.REASON_LOW_MEMORY;
    }

    private JSONObject serializeExit(ApplicationExitInfo info) throws JSONException, IOException {
        JSONObject result = new JSONObject();
        result.put("reason", info.getReason());
        result.put("status", info.getStatus());
        result.put("timestamp", info.getTimestamp());
        result.put("processName", info.getProcessName());
        result.put("importance", info.getImportance());
        result.put("pssKb", info.getPss());
        result.put("rssKb", info.getRss());
        result.put("description", CogniaCrashPolicy.redact(info.getDescription()));
        try (InputStream trace = info.getTraceInputStream()) {
            if (trace != null) {
                result.put("trace", CogniaCrashPolicy.redact(readBounded(trace)));
            }
        }
        return result;
    }

    private static String readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int remaining = CogniaCrashPolicy.MAX_TRACE_BYTES;
        while (remaining > 0) {
            int count = input.read(buffer, 0, Math.min(buffer.length, remaining));
            if (count < 0) {
                break;
            }
            output.write(buffer, 0, count);
            remaining -= count;
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private Object parsePayload(String payload) {
        try {
            return new JSONObject(payload);
        } catch (JSONException objectError) {
            try {
                return new JSONArray(payload);
            } catch (JSONException arrayError) {
                return payload;
            }
        }
    }

    private File reportFile(String incidentId) throws IOException {
        String safeId = CogniaCrashPolicy.safeStem(incidentId);
        if (!safeId.equals(incidentId)) {
            throw new IOException("Invalid incident identifier");
        }
        return new File(reportDirectory, safeId + REPORT_SUFFIX);
    }

    private JSONObject readEnvelope(File file) throws IOException {
        if (file.length() < 0 || file.length() > CogniaCrashPolicy.MAX_REPORT_BYTES) {
            throw new IOException("Crash report exceeds local read limit");
        }
        byte[] content;
        try (FileInputStream input = new FileInputStream(file)) {
            content = new byte[(int) Math.min(file.length(), Integer.MAX_VALUE)];
            int offset = 0;
            while (offset < content.length) {
                int count = input.read(content, offset, content.length - offset);
                if (count < 0) {
                    break;
                }
                offset += count;
            }
        }
        try {
            return new JSONObject(new String(content, StandardCharsets.UTF_8));
        } catch (JSONException exception) {
            throw new IOException("Invalid crash report", exception);
        }
    }

    private void writeAtomically(File target, String content) throws IOException {
        ensureDirectory();
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > CogniaCrashPolicy.MAX_REPORT_BYTES) {
            throw new IOException("Crash report exceeds local persistence limit");
        }
        File temporary = new File(reportDirectory, target.getName() + ".tmp");
        File backup = new File(reportDirectory, target.getName() + ".bak");
        try (FileOutputStream output = new FileOutputStream(temporary, false)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
        if (backup.exists() && !backup.delete()) {
            throw new IOException("Unable to clear stale crash report backup");
        }
        if (target.exists() && !target.renameTo(backup)) {
            throw new IOException("Unable to stage existing crash report");
        }
        if (!temporary.renameTo(target)) {
            if (backup.exists()) {
                backup.renameTo(target);
            }
            throw new IOException("Unable to commit crash report");
        }
        if (backup.exists()) {
            backup.delete();
        }
    }

    private void ensureDirectory() throws IOException {
        if (!reportDirectory.isDirectory() && !reportDirectory.mkdirs()) {
            throw new IOException("Unable to create crash report directory");
        }
    }

    private File[] sortedReports() {
        File[] reports = reportDirectory.listFiles(file -> file.isFile() && file.getName().endsWith(REPORT_SUFFIX));
        if (reports == null) {
            return new File[0];
        }
        Arrays.sort(reports, Comparator.comparingLong(File::lastModified).reversed());
        return reports;
    }

    private void prune() {
        long now = System.currentTimeMillis();
        long retainedBytes = 0;
        int retainedCount = 0;
        for (File report : sortedReports()) {
            boolean expired = now - report.lastModified() > CogniaCrashPolicy.MAX_AGE_MILLIS;
            boolean overCount = retainedCount >= CogniaCrashPolicy.MAX_INCIDENTS;
            boolean overBytes = retainedBytes + report.length() > CogniaCrashPolicy.MAX_TOTAL_BYTES;
            if (expired || overCount || overBytes) {
                report.delete();
            } else {
                retainedCount += 1;
                retainedBytes += report.length();
            }
        }
    }

    private long readExitWatermark() {
        File watermark = new File(reportDirectory, EXIT_WATERMARK);
        if (!watermark.isFile()) {
            return 0;
        }
        try (FileInputStream input = new FileInputStream(watermark)) {
            byte[] content = new byte[(int) Math.min(watermark.length(), 32)];
            int count = input.read(content);
            return Long.parseLong(new String(content, 0, Math.max(count, 0), StandardCharsets.UTF_8));
        } catch (IOException | NumberFormatException ignored) {
            return 0;
        }
    }

    private void writeExitWatermark(long timestamp) {
        try {
            ensureDirectory();
            writeAtomically(new File(reportDirectory, EXIT_WATERMARK), Long.toString(timestamp));
        } catch (IOException ignored) {
            // A missing watermark only causes bounded re-processing on a later start.
        }
    }
}
