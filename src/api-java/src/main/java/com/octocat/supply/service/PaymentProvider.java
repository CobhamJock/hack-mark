package com.octocat.supply.service;

import com.octocat.supply.model.CheckoutModel.Checkout;
import com.octocat.supply.model.CheckoutModel.Snapshot;
import java.util.List;

public interface PaymentProvider {
    record Session(String id, String url, String status, String paymentStatus,
                   String clientReferenceId, String checkoutId, String currency,
                   Long amountTotal, String paymentIntentId) {}

    void validateConfiguration();
    Session create(Checkout checkout, List<Snapshot> items);
    Session retrieve(String sessionId);
    Session expire(String sessionId);
    boolean refund(String checkoutId, String paymentIntentId);
}
