package com.octocat.supply.controller;

import com.octocat.supply.exception.ValidationException;

final class ControllerValidation {
    private ControllerValidation() {
    }

    static void requireText(String value, String fieldName) {
        if (value == null || value.isBlank()) {
            throw new ValidationException(fieldName + " is required");
        }
    }

    static void requirePositive(Integer value, String fieldName) {
        if (value == null || value <= 0) {
            throw new ValidationException(fieldName + " is required");
        }
    }

    static int positiveId(String value, String fieldName) {
        if (value == null || !value.matches("[0-9]+")) {
            throw new ValidationException(fieldName + " must be a positive integer");
        }
        try {
            int id = Integer.parseInt(value);
            requirePositive(id, fieldName);
            return id;
        } catch (NumberFormatException ex) {
            throw new ValidationException(fieldName + " must be a positive integer");
        }
    }
}
