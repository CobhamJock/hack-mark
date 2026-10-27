package com.octocat.supply.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.PaymentException;
import com.octocat.supply.model.CheckoutModel.Checkout;
import com.octocat.supply.model.CheckoutModel.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.env.MockEnvironment;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class StripeTransportTest {
    private static final String ID = "ed6c1980-379e-4e8f-a41d-599812710124";
    private final HttpClient client = mock(HttpClient.class);
    private final StripePaymentProvider provider = new StripePaymentProvider(new MockEnvironment()
        .withProperty("PAYMENT_PROVIDER", "stripe").withProperty("STRIPE_SECRET_KEY", "sk_test_private")
        .withProperty("CHECKOUT_PUBLIC_URL", "https://shop.example"), new ObjectMapper(), client);
    private HttpResponse<String> response;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setup() throws Exception {
        response = mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(200);
        when(response.body()).thenReturn("{\"id\":\"cs_test\",\"url\":\"https://checkout.stripe.com/pay/test\"}");
        when(client.send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class))).thenReturn(response);
    }

    @Test
    void createUsesFixedEndpointTimeoutIdempotencyAndSnapshotForm() throws Exception {
        Checkout checkout = new Checkout(ID, 1, "{}", "[]", 202, "creating", null, null, null, null, "");
        provider.create(checkout, List.of(new Snapshot(1, 2, 101, "Name & value")));
        HttpRequest request = request();
        assertThat(request.uri().toString()).isEqualTo("https://api.stripe.com/v1/checkout/sessions");
        assertThat(request.timeout()).contains(Duration.ofSeconds(15));
        assertThat(request.headers().firstValue("Idempotency-Key")).contains("checkout-" + ID);
        assertThat(request.headers().firstValue("Content-Type")).contains("application/x-www-form-urlencoded");
        String form = body(request);
        assertThat(form).contains("mode=payment", "payment_method_types[0]=card",
            "success_url=https://shop.example/checkout?checkoutId=" + ID + "&result=success",
            "cancel_url=https://shop.example/checkout?checkoutId=" + ID + "&result=cancel",
            "client_reference_id=" + ID, "metadata[checkoutId]=" + ID,
            "line_items[0][quantity]=2", "line_items[0][price_data][currency]=usd",
            "line_items[0][price_data][unit_amount]=101",
            "line_items[0][price_data][product_data][name]=Name & value");
        assertThat(form).doesNotContain("sk_test_private");
    }

    @Test
    void retrieveExpireAndRefundUseExpectedMethodsAndRefundKey() throws Exception {
        provider.retrieve("cs_test");
        assertThat(request().method()).isEqualTo("GET");
        clearInvocations(client);
        provider.expire("cs_test");
        assertThat(request().uri().toString()).endsWith("/checkout/sessions/cs_test/expire");
        assertThat(request().method()).isEqualTo("POST");
        clearInvocations(client);
        when(response.body()).thenReturn("{\"status\":\"pending\"}");
        assertThat(provider.refund(ID, "pi_test")).isFalse();
        HttpRequest request = request();
        assertThat(request.uri().toString()).isEqualTo("https://api.stripe.com/v1/refunds");
        assertThat(request.headers().firstValue("Idempotency-Key")).contains("refund-" + ID);
        assertThat(body(request)).isEqualTo("payment_intent=pi_test");
        when(response.body()).thenReturn("{\"status\":\"succeeded\"}");
        assertThat(provider.refund(ID, "pi_test")).isTrue();
    }

    @Test
    void providerHttpNetworkAndMalformedFailuresAreSafe() throws Exception {
        when(response.statusCode()).thenReturn(402);
        when(response.body()).thenReturn("private provider body sk_test_private");
        safeFailure();
        when(response.statusCode()).thenReturn(200);
        when(response.body()).thenReturn("not JSON");
        safeFailure();
        when(client.send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
            .thenThrow(new IOException("private network error sk_test_private"));
        safeFailure();
    }

    @Test
    void sessionPathCannotRedirectProviderRequests() {
        assertThatThrownBy(() -> provider.retrieve("../evil")).isInstanceOf(PaymentException.class);
        verifyNoInteractions(client);
    }

    private void safeFailure() {
        assertThatThrownBy(() -> provider.retrieve("cs_test"))
            .isInstanceOfSatisfying(PaymentException.class, ex -> {
                assertThat(ex.getCode()).isEqualTo("PAYMENT_PROVIDER_ERROR");
                assertThat(ex.getMessage()).isEqualTo("Payment provider request failed");
                assertThat(ex.getCause()).isNull();
            });
    }

    private HttpRequest request() throws Exception {
        ArgumentCaptor<HttpRequest> captor = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client).send(captor.capture(), any(HttpResponse.BodyHandler.class));
        return captor.getValue();
    }

    private String body(HttpRequest request) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        CompletableFuture<Void> done = new CompletableFuture<>();
        request.bodyPublisher().orElseThrow().subscribe(new Flow.Subscriber<ByteBuffer>() {
            public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
            public void onNext(ByteBuffer buffer) {
                byte[] chunk = new byte[buffer.remaining()];
                buffer.get(chunk);
                bytes.writeBytes(chunk);
            }
            public void onError(Throwable error) { done.completeExceptionally(error); }
            public void onComplete() { done.complete(null); }
        });
        done.get();
        return URLDecoder.decode(bytes.toString(StandardCharsets.UTF_8), StandardCharsets.UTF_8);
    }
}
