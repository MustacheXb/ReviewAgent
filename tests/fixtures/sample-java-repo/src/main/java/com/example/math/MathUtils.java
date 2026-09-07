package com.example.math;

/**
 * Stateless arithmetic helpers for the sample repository.
 */
public final class MathUtils {

    private MathUtils() {
    }

    /**
     * Sums the first {@code count} elements of {@code values}.
     *
     * @param values array to read from, must not be null
     * @param count number of leading elements to sum
     * @return the sum of the first {@code count} elements
     */
    public static int sumFirst(int[] values, int count) {
        int sum = 0;
        for (int i = 0; i < count; i++) {
            sum += values[i];
        }
        return sum;
    }
}
