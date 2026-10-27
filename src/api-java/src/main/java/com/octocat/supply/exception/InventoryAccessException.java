package com.octocat.supply.exception;

public class InventoryAccessException extends ApiException {
    private final boolean unavailable;

    public InventoryAccessException(boolean unavailable) {
        super(unavailable ? "SERVICE_UNAVAILABLE" : "FORBIDDEN",
            unavailable ? "Inventory administration is unavailable" : "Inventory administrator authorization required");
        this.unavailable = unavailable;
    }

    public boolean isUnavailable() {
        return unavailable;
    }
}
