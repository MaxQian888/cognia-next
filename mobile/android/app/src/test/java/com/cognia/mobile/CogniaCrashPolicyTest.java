package com.cognia.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class CogniaCrashPolicyTest {
    @Test
    public void redactsCredentialsIdentityAndHomePaths() {
        String source = "Bearer abc.def email=user@example.com password=hunter2 /Users/alice/project "
            + "C:\\Users\\bob\\project";
        String redacted = CogniaCrashPolicy.redact(source);

        assertFalse(redacted.contains("abc.def"));
        assertFalse(redacted.contains("user@example.com"));
        assertFalse(redacted.contains("hunter2"));
        assertFalse(redacted.contains("alice"));
        assertFalse(redacted.contains("bob"));
        assertTrue(redacted.contains("[REDACTED_AUTHORIZATION]"));
        assertTrue(redacted.contains("[REDACTED_CREDENTIAL]"));
    }

    @Test
    public void safeStemRejectsTraversalAndBoundsLength() {
        assertEquals("incident", CogniaCrashPolicy.safeStem(".."));
        assertEquals(".._report", CogniaCrashPolicy.safeStem("../report"));
        assertTrue(CogniaCrashPolicy.safeStem("x".repeat(200)).length() <= 80);
    }

    @Test
    public void stableIdIsDeterministicAndSourceScoped() {
        String first = CogniaCrashPolicy.stableId("acra", "payload");
        assertEquals(first, CogniaCrashPolicy.stableId("acra", "payload"));
        assertFalse(first.equals(CogniaCrashPolicy.stableId("exit-info", "payload")));
        assertEquals(32, first.length());
    }
}
