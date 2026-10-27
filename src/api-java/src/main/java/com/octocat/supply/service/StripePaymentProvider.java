package com.octocat.supply.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.PaymentException;
import com.octocat.supply.model.CheckoutModel.Checkout;
import com.octocat.supply.model.CheckoutModel.Snapshot;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Autowired;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Component
public class StripePaymentProvider implements PaymentProvider {
    private final Environment environment;
    private final ObjectMapper json;
    private final HttpClient client;

    @Autowired
    public StripePaymentProvider(Environment environment, ObjectMapper json) {
        this(environment, json, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NEVER).build());
    }

    StripePaymentProvider(Environment environment, ObjectMapper json, HttpClient client) {
        this.environment = environment;
        this.json = json;
        this.client = client;
    }

    @Override
    public void validateConfiguration() {
        try {
            if (!"stripe".equals(environment.getProperty("PAYMENT_PROVIDER"))
                || environment.getProperty("STRIPE_SECRET_KEY", "").isBlank()) {
                throw new IllegalArgumentException();
            }
            URI origin = URI.create(environment.getProperty("CHECKOUT_PUBLIC_URL", ""));
            boolean local = "localhost".equals(origin.getHost()) || "127.0.0.1".equals(origin.getHost());
            if (origin.getHost() == null || origin.getRawUserInfo() != null
                || origin.getRawQuery() != null || origin.getRawFragment() != null
                || (origin.getRawPath() != null && !origin.getRawPath().isEmpty())
                || !("https".equals(origin.getScheme()) || ("http".equals(origin.getScheme()) && local))
                || origin.getPort() > 65535 || origin.getPort() == 0
                || origin.getRawAuthority().endsWith(":")
                || !origin.toString().equals(origin.getScheme() + "://" + origin.getRawAuthority())) {
                throw new IllegalArgumentException();
            }
            // Header values must not contain control characters.
            if (environment.getProperty("STRIPE_SECRET_KEY", "").chars().anyMatch(c -> c < 33 || c > 126)) {
                throw new IllegalArgumentException();
            }
        } catch (RuntimeException ex) {
            throw new PaymentException(503, "PAYMENT_UNAVAILABLE", "Payment service is not configured");
        }
    }

    @Override
    public Session create(Checkout checkout, List<Snapshot> items) {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("mode", "payment");
        form.put("payment_method_types[0]", "card");
        String base = environment.getProperty("CHECKOUT_PUBLIC_URL") + "/checkout?checkoutId=" + checkout.checkoutId();
        form.put("success_url", base + "&result=success");
        form.put("cancel_url", base + "&result=cancel");
        form.put("client_reference_id", checkout.checkoutId());
        form.put("metadata[checkoutId]", checkout.checkoutId());
        for (int i = 0; i < items.size(); i++) {
            Snapshot item = items.get(i);
            String prefix = "line_items[" + i + "]";
            form.put(prefix + "[quantity]", Integer.toString(item.quantity()));
            form.put(prefix + "[price_data][currency]", "usd");
            form.put(prefix + "[price_data][unit_amount]", Integer.toString(item.unitPriceCents()));
            form.put(prefix + "[price_data][product_data][name]", item.name());
        }
        return session(call("POST", "/checkout/sessions", form, "checkout-" + checkout.checkoutId()));
    }

    @Override
    public Session retrieve(String id) {
        return session(call("GET", "/checkout/sessions/" + sessionId(id), Map.of(), null));
    }

    @Override
    public Session expire(String id) {
        return session(call("POST", "/checkout/sessions/" + sessionId(id) + "/expire", Map.of(), null));
    }

    @Override
    public boolean refund(String id, String intent) {
        return "succeeded".equals(call("POST", "/refunds", Map.of("payment_intent", intent),
            "refund-" + id).path("status").asText());
    }

    private String sessionId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_]+")) {
            throw failure();
        }
        return id;
    }

    private JsonNode call(String method, String path, Map<String, String> form, String key) {
        validateConfiguration();
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("https://api.stripe.com/v1" + path))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + environment.getProperty("STRIPE_SECRET_KEY"));
            if (key != null) {
                request.header("Idempotency-Key", key);
            }
            if ("POST".equals(method)) {
                String body = form.entrySet().stream().map(e -> encode(e.getKey()) + "=" + encode(e.getValue()))
                    .collect(Collectors.joining("&"));
                request.header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body));
            } else {
                request.GET();
            }
            HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw failure();
            }
            JsonNode result = json.readTree(response.body());
            if (result == null || !result.isObject()) {
                throw failure();
            }
            return result;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw failure();
        } catch (Exception ex) {
            throw failure();
        }
    }

    private Session session(JsonNode node) {
        JsonNode amount = node.path("amount_total");
        return new Session(text(node, "id"), text(node, "url"), text(node, "status"),
            text(node, "payment_status"), text(node, "client_reference_id"),
            text(node.path("metadata"), "checkoutId"), text(node, "currency"),
            amount.isIntegralNumber() && amount.canConvertToLong() ? amount.longValue() : null,
            text(node, "payment_intent"));
    }

    private static String text(JsonNode node, String key) {
        return node.path(key).isTextual() ? node.path(key).textValue() : null;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    public static PaymentException failure() {
        return new PaymentException(502, "PAYMENT_PROVIDER_ERROR", "Payment provider request failed");
    }
}
