package com.example.util;

/**
 * String helpers for the sample repository (second package, used by scope tests).
 */
public final class StringUtils {

    private StringUtils() {
    }

    /**
     * Joins parts with the given separator; null-safe.
     */
    public static String join(String[] parts, String separator) {
        if (parts == null || parts.length == 0) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) {
                builder.append(separator);
            }
            builder.append(parts[i]);
        }
        return builder.toString();
    }

    /**
     * Returns true when the text is null or blank.
     */
    public static boolean isBlank(String text) {
        return text == null || text.trim().isEmpty();
    }
}
