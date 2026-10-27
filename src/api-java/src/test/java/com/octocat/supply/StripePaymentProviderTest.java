package com.octocat.supply;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.PaymentException;
import com.octocat.supply.service.StripePaymentProvider;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.*;

class StripePaymentProviderTest {
    @ParameterizedTest
    @ValueSource(strings = {"https://shop.example", "http://localhost", "http://127.0.0.1:5137",
        "https://shop.example:443"})
    void acceptsOnlySupportedOrigins(String origin) {
        assertThatCode(() -> provider(origin).validateConfiguration()).doesNotThrowAnyException();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "http://shop.example", "https://shop.example/", "https://user@shop.example",
        "https://shop.example?x=1", "https://shop.example#fragment", "https://shop.example/path",
        "ftp://localhost", "https://shop.example:99999", "https://shop.example:0", "https://shop.example:", "//shop.example"})
    void invalidOriginsAreSafelyUnavailable(String origin) {
        assertThatThrownBy(() -> provider(origin).validateConfiguration())
            .isInstanceOfSatisfying(PaymentException.class, ex -> {
                assertThat(ex.getStatus()).isEqualTo(503);
                assertThat(ex.getCode()).isEqualTo("PAYMENT_UNAVAILABLE");
                assertThat(ex.getMessage()).doesNotContain("sk_test");
            });
    }

    @Test
    void missingWrongProviderAndSecretAreUnavailable() {
        for (MockEnvironment environment : new MockEnvironment[]{
                new MockEnvironment(),
                new MockEnvironment().withProperty("PAYMENT_PROVIDER", "other"),
                new MockEnvironment().withProperty("PAYMENT_PROVIDER", "stripe")
                    .withProperty("CHECKOUT_PUBLIC_URL", "https://shop.example")}) {
            assertThatThrownBy(() -> new StripePaymentProvider(environment, new ObjectMapper()).validateConfiguration())
                .isInstanceOf(PaymentException.class);
        }
    }

    private StripePaymentProvider provider(String origin) {
        return new StripePaymentProvider(new MockEnvironment().withProperty("PAYMENT_PROVIDER", "stripe")
            .withProperty("STRIPE_SECRET_KEY", "sk_test_not_real").withProperty("CHECKOUT_PUBLIC_URL", origin),
            new ObjectMapper());
    }
}
