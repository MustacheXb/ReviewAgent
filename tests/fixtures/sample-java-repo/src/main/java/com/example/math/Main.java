package com.example.math;

/**
 * Demo entry point for the sample repository.
 */
public final class Main {

    public static void main(String[] args) {
        int[] readings = {1, 2, 3, 4, 5};
        Calculator calculator = new Calculator();
        System.out.println(calculator.total(readings, readings.length));
    }
}
