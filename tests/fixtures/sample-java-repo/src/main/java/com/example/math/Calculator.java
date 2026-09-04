package com.example.math;

/**
 * Simple calculator facade built on {@link MathUtils}.
 */
public final class Calculator {

    /**
     * Computes the total of the first {@code count} readings.
     */
    public int total(int[] readings, int count) {
        return MathUtils.sumFirst(readings, count);
    }
}
