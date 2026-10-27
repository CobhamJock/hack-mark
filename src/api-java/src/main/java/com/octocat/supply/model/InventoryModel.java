package com.octocat.supply.model;

public final class InventoryModel {
    private InventoryModel() {
    }

    public record Inventory(int branchId, int productId, int quantityOnHand) {
    }

    public record UpdateInventoryRequest(Integer quantityOnHand) {
    }
}
