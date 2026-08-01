package com.cognia.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

final class CogniaCrashPolicy {
    static final int MAX_INCIDENTS = 50;
    static final long MAX_TOTAL_BYTES = 1024L * 1024L * 1024L;
    static final int MAX_REPORT_BYTES = 100 * 1024 * 1024;
    static final long MAX_AGE_MILLIS = 30L * 24L * 60L * 60L * 1000L;
    static final int MAX_EXIT_RECORDS = 5;
    static final int MAX_TRACE_BYTES = 512 * 1024;

    private static final Pattern BEARER = Pattern.compile(
        "(?i)\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/-]+=*"
    );
    private static final Pattern EMAIL = Pattern.compile(
        "(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}(?![A-Z0-9._%+-])"
    );
    private static final Pattern CREDENTIAL_ASSIGNMENT = Pattern.compile(
        "(?i)\\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\\b\\s*[:=]\\s*[^\\s,;\\\"']+"
    );
    private static final Pattern UNIX_HOME = Pattern.compile("/(Users|home)/[^/\\s]+/");
    private static final Pattern WINDOWS_HOME = Pattern.compile("(?i)[A-Z]:\\\\Users\\\\[^\\\\\\s]+\\\\");
    private static final Pattern SAFE_STEM = Pattern.compile("[^A-Za-z0-9._-]");

    private CogniaCrashPolicy() {}

    static String redact(String value) {
        if (value == null || value.isEmpty()) {
            return value;
        }
        String redacted = BEARER.matcher(value).replaceAll("[REDACTED_AUTHORIZATION]");
        redacted = EMAIL.matcher(redacted).replaceAll("[REDACTED_EMAIL]");
        redacted = CREDENTIAL_ASSIGNMENT.matcher(redacted).replaceAll("$1=[REDACTED_CREDENTIAL]");
        redacted = UNIX_HOME.matcher(redacted).replaceAll("/$1/[REDACTED_USER]/");
        return WINDOWS_HOME.matcher(redacted).replaceAll("C:\\\\Users\\\\[REDACTED_USER]\\\\");
    }

    static String safeStem(String value) {
        String source = value == null ? "" : value.trim();
        String stem = SAFE_STEM.matcher(source).replaceAll("_");
        if (stem.isEmpty() || stem.equals(".") || stem.equals("..")) {
            stem = "incident";
        }
        if (stem.length() > 80) {
            stem = stem.substring(0, 80);
        }
        return stem;
    }

    static String stableId(String source, String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((source + "\n" + content).getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(32);
            for (int index = 0; index < 16; index += 1) {
                result.append(String.format(Locale.ROOT, "%02x", hash[index]));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
