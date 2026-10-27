package com.octocat.supply.model;

import java.util.List;

public final class CheckoutModel {
    private CheckoutModel() {}

    public record Item(int productId, int quantity) {}
    public record Request(int branchId, List<Item> items) {}
    public record Snapshot(int productId, int quantity, int unitPriceCents, String name) {}
    public record Checkout(String checkoutId, int branchId, String requestJson, String itemsJson,
                           int amountTotal, String status, String sessionId, String checkoutUrl,
                           String paymentIntentId, Integer orderId, String createdAt) {
        public Response response() {
            return new Response(checkoutId, status, checkoutUrl, amountTotal, "usd", orderId);
        }
    }
    public record Response(String checkoutId, String status, String checkoutUrl, int amountTotal,
                           String currency, Integer orderId) {}
}
