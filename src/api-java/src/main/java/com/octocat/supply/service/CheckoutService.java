package com.octocat.supply.service;

import com.octocat.supply.exception.ConflictException;
import com.octocat.supply.exception.PaymentException;
import com.octocat.supply.model.CheckoutModel.*;
import com.octocat.supply.repository.CheckoutRepository;
import org.springframework.stereotype.Service;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Objects;

@Service
public class CheckoutService {
    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);
    private final CheckoutRepository repository;
    private final PaymentProvider provider;

    public CheckoutService(CheckoutRepository repository, PaymentProvider provider) {
        this.repository = repository;
        this.provider = provider;
    }

    public Response create(String id, Request request) {
        provider.validateConfiguration();
        Checkout checkout = repository.createOrRead(id, request);
        if (!"creating".equals(checkout.status())) {
            return checkout.response();
        }
        Instant created = LocalDateTime.parse(checkout.createdAt(),
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")).toInstant(ZoneOffset.UTC);
        if (Duration.between(created, Instant.now()).compareTo(Duration.ofHours(23)) > 0) {
            log.warn("Checkout {} creation requires manual reconciliation", id);
            throw new ConflictException("Checkout outcome unknown; manual reconciliation required");
        }
        PaymentProvider.Session session = provider.create(checkout, repository.snapshots(checkout));
        if (session.id() == null || !session.id().matches("[A-Za-z0-9_]+") || !safeUrl(session.url())) {
            throw StripePaymentProvider.failure();
        }
        return repository.saveSession(id, session.id(), session.url()).response();
    }

    public Response complete(String id) {
        Checkout checkout = repository.require(id);
        if (terminal(checkout)) {
            return checkout.response();
        }
        provider.validateConfiguration();
        if ("refund_pending".equals(checkout.status())) {
            return refund(checkout);
        }
        if (checkout.sessionId() == null) {
            throw new ConflictException("Checkout creation must be retried first");
        }
        PaymentProvider.Session session = provider.retrieve(checkout.sessionId());
        verify(checkout, session);
        return complete(checkout, session);
    }

    private Response complete(Checkout checkout, PaymentProvider.Session session) {
        if (!"paid".equals(session.paymentStatus())) {
            if ("expired".equals(session.status()) && "unpaid".equals(session.paymentStatus())) {
                return repository.cancel(checkout.checkoutId()).response();
            }
            throw new PaymentException(409, "PAYMENT_PENDING", "Payment has not completed");
        }
        if (!"complete".equals(session.status()) || session.paymentIntentId() == null
                || session.paymentIntentId().isBlank()) {
            throw StripePaymentProvider.failure();
        }
        Checkout result = repository.finalizePaid(checkout.checkoutId(), session.paymentIntentId());
        return "refund_pending".equals(result.status()) ? refund(result) : result.response();
    }

    public Response cancel(String id) {
        Checkout checkout = repository.require(id);
        if (terminal(checkout)) {
            return checkout.response();
        }
        provider.validateConfiguration();
        if ("refund_pending".equals(checkout.status())) {
            return refund(checkout);
        }
        if (checkout.sessionId() == null) {
            throw new ConflictException("Checkout creation must be retried first");
        }
        PaymentProvider.Session session = provider.retrieve(checkout.sessionId());
        verify(checkout, session);
        if ("paid".equals(session.paymentStatus())) {
            return complete(checkout, session);
        }
        if ("open".equals(session.status()) && "unpaid".equals(session.paymentStatus())) {
            session = provider.expire(checkout.sessionId());
            verify(checkout, session);
        }
        if ("paid".equals(session.paymentStatus())) {
            return complete(checkout, session);
        }
        if (!"expired".equals(session.status()) || !"unpaid".equals(session.paymentStatus())) {
            throw StripePaymentProvider.failure();
        }
        return repository.cancel(id).response();
    }

    private Response refund(Checkout checkout) {
        try {
            if (checkout.paymentIntentId() == null || checkout.paymentIntentId().isBlank()
                    || !provider.refund(checkout.checkoutId(), checkout.paymentIntentId())) {
                throw new IllegalStateException();
            }
            return repository.refunded(checkout.checkoutId()).response();
        } catch (RuntimeException ex) {
            log.warn("Checkout {} refund requires retry", checkout.checkoutId());
            throw new PaymentException(502, "REFUND_PENDING", "Refund requires retry; no order was created");
        }
    }

    private void verify(Checkout checkout, PaymentProvider.Session session) {
        if (!Objects.equals(checkout.sessionId(), session.id())
                || !Objects.equals(checkout.checkoutId(), session.clientReferenceId())
                || !Objects.equals(checkout.checkoutId(), session.checkoutId())
                || !"usd".equals(session.currency()) || session.amountTotal() == null
                || session.amountTotal() != checkout.amountTotal()) {
            throw StripePaymentProvider.failure();
        }
    }

    private boolean terminal(Checkout checkout) {
        return "completed".equals(checkout.status()) || "cancelled".equals(checkout.status())
            || "refunded".equals(checkout.status());
    }

    private boolean safeUrl(String url) {
        try {
            URI uri = URI.create(url);
            return "https".equals(uri.getScheme()) && "checkout.stripe.com".equals(uri.getHost())
                && uri.getRawUserInfo() == null && uri.getPort() == -1
                && uri.getRawPath() != null && uri.getRawPath().length() > 1;
        } catch (RuntimeException ex) {
            return false;
        }
    }
}
