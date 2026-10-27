package com.octocat.supply;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.PaymentException;
import com.octocat.supply.model.CheckoutModel.Checkout;
import com.octocat.supply.repository.CheckoutRepository;
import com.octocat.supply.service.PaymentProvider;
import com.octocat.supply.service.PaymentProvider.Session;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "app.db-file=./target/test-data/checkout.db")
@AutoConfigureMockMvc
class CheckoutApiTest {
    private static final String ID = "ed6c1980-379e-4e8f-a41d-599812710124";
    private static final String BODY = """
        {"checkoutId":"ed6c1980-379e-4e8f-a41d-599812710124","branchId":1,
         "items":[{"productId":1,"quantity":2}]}
        """;
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired CheckoutRepository repository;
    @MockBean PaymentProvider provider;

    @BeforeEach
    void reset() {
        org.mockito.Mockito.reset(provider);
        jdbc.execute("DROP TRIGGER IF EXISTS reject_checkout_order");
        jdbc.update("DELETE FROM checkouts");
        jdbc.update("DELETE FROM order_detail_deliveries");
        jdbc.update("DELETE FROM order_details");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM inventory");
        jdbc.update("UPDATE products SET price = 129.99, discount = 0.25 WHERE product_id = 1");
        jdbc.update("INSERT INTO inventory(branch_id, product_id, quantity_on_hand) VALUES (1, 1, 20)");
        when(provider.create(any(), anyList())).thenAnswer(invocation -> {
            Checkout row = invocation.getArgument(0);
            assertThat(repository.require(ID).status()).isEqualTo("creating");
            return session(row.amountTotal(), "open", "unpaid", null);
        });
        when(provider.retrieve("cs_test")).thenAnswer(invocation ->
            session(repository.require(ID).amountTotal(), "complete", "paid", "pi_test"));
        when(provider.expire("cs_test")).thenAnswer(invocation ->
            session(repository.require(ID).amountTotal(), "expired", "unpaid", null));
        when(provider.refund(ID, "pi_test")).thenReturn(true);
    }

    @Test
    void happyPathSnapshotAndSemanticRetryNeverDuplicate() throws Exception {
        create().andExpect(jsonPath("$.amountTotal").value(19498))
            .andExpect(jsonPath("$.currency").value("usd")).andExpect(jsonPath("$.orderId").isEmpty());
        assertThat(stock()).isEqualTo(20);
        jdbc.update("UPDATE products SET price = 500, discount = 0 WHERE product_id = 1");
        jdbc.update("UPDATE checkouts SET request_json = ? WHERE checkout_id = ?",
            "{\"items\":[{\"quantity\":2,\"productId\":1}],\"branchId\":1}", ID);
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON)
                .content(BODY.replace("{\"productId\":1,\"quantity\":2}",
                    "{\"productId\":1,\"quantity\":1},{\"productId\":1,\"quantity\":1}")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.amountTotal").value(19498));
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("completed"))
            .andExpect(jsonPath("$.orderId").isNumber());
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("completed"));
        create().andExpect(jsonPath("$.status").value("completed"));
        assertThat(count("orders")).isEqualTo(1);
        assertThat(count("order_details")).isEqualTo(1);
        assertThat(stock()).isEqualTo(18);
        assertThat(jdbc.queryForObject("SELECT unit_price FROM order_details", Double.class)).isEqualTo(97.49);
        assertThat(jdbc.queryForObject("SELECT status FROM orders", String.class)).isEqualTo("confirmed");
        verify(provider, times(1)).create(any(), anyList());
        verify(provider, times(1)).retrieve(anyString());
    }

    @Test
    void requestMismatchConflictsWithoutRemoteCall() throws Exception {
        create();
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON)
                .content(BODY.replace("\"quantity\":2", "\"quantity\":3")))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("CONFLICT"));
        verify(provider, times(1)).create(any(), anyList());
    }

    @Test
    void unpaidDeclinedAndExpiredSessionsDoNotCreateOrders() throws Exception {
        create();
        when(provider.retrieve("cs_test")).thenReturn(session(19498, "open", "unpaid", null));
        complete().andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("PAYMENT_PENDING"));
        assertThat(count("orders")).isZero();
        when(provider.retrieve("cs_test")).thenReturn(session(19498, "expired", "unpaid", null));
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
        create().andExpect(jsonPath("$.status").value("cancelled"));
        verify(provider, times(1)).create(any(), anyList());
        assertThat(stock()).isEqualTo(20);
    }

    @Test
    void providerFailureLeavesDurableSnapshotAndRetriesSameRequest() throws Exception {
        doThrow(new PaymentException(502,
            "PAYMENT_PROVIDER_ERROR", "Payment provider request failed")).when(provider).create(any(), anyList());
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("PAYMENT_PROVIDER_ERROR"));
        Checkout row = repository.require(ID);
        assertThat(row.status()).isEqualTo("creating");
        jdbc.update("UPDATE products SET price = 900 WHERE product_id = 1");
        doAnswer(invocation -> {
            Checkout retry = invocation.getArgument(0);
            assertThat(retry.itemsJson()).isEqualTo(row.itemsJson());
            assertThat(retry.amountTotal()).isEqualTo(19498);
            return session(retry.amountTotal(), "open", "unpaid", null);
        }).when(provider).create(any(), anyList());
        create();
        verify(provider, times(2)).create(any(), anyList());
        assertThat(count("checkouts")).isEqualTo(1);
    }

    @Test
    void oldUnknownCreationRequiresReconciliationWithoutProvider() throws Exception {
        doThrow(new PaymentException(502, "PAYMENT_PROVIDER_ERROR", "Failed")).when(provider).create(any(), anyList());
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isBadGateway());
        jdbc.update("UPDATE checkouts SET created_at = datetime('now', '-24 hours')");
        clearInvocations(provider);
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.error.message").value(
                "Checkout outcome unknown; manual reconciliation required"));
        verify(provider, never()).create(any(), anyList());
    }

    @Test
    void invalidConfigurationStopsBeforeAnyProviderOrDatabaseWrite() throws Exception {
        doThrow(new PaymentException(503, "PAYMENT_UNAVAILABLE", "Payment service is not configured"))
            .when(provider).validateConfiguration();
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.error.code").value("PAYMENT_UNAVAILABLE"));
        assertThat(count("checkouts")).isZero();
        verify(provider, never()).create(any(), anyList());
    }

    @Test
    void missingBranchProductAndStockStopBeforeProvider() throws Exception {
        for (String body : List.of(BODY.replace("\"branchId\":1", "\"branchId\":99999"),
                BODY.replace("\"productId\":1", "\"productId\":99999"))) {
            mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isNotFound());
        }
        jdbc.update("DELETE FROM inventory");
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isConflict());
        assertThat(count("checkouts")).isZero();
        verify(provider, never()).create(any(), anyList());
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "-1", "1.5", "\"2\"", "true", "2147483648", "null"})
    void strictIntegers(String quantity) throws Exception {
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON)
                .content(BODY.replace("\"quantity\":2", "\"quantity\":" + quantity)))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        verifyNoInteractions(provider);
    }

    @Test
    void shapeUuidLimitsAndDuplicateOverflow() throws Exception {
        for (String body : List.of("{}", "null", BODY.replace(ID, ID.toUpperCase()),
                BODY.replace(ID, ID.replace("4e8f", "5e8f")),
                BODY.replace("\"branchId\":1", "\"branchId\":true"),
                BODY.replace("[{\"productId\":1,\"quantity\":2}]", "[]"),
                BODY.replace("[{\"productId\":1,\"quantity\":2}]", "null"),
                BODY.replace("\"quantity\":2", "\"quantity\":2147483647")
                    .replace("}]}", "},{\"productId\":1,\"quantity\":1}]}"))) {
            mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest());
        }
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < 101; i++) lines.add("{\"productId\":1,\"quantity\":1}");
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON)
                .content(BODY.replace("[{\"productId\":1,\"quantity\":2}]", "[" + String.join(",", lines) + "]")))
            .andExpect(status().isBadRequest());
        verifyNoInteractions(provider);
    }

    @Test
    void validatesPriceAndAmountLimitAndHalfUp() throws Exception {
        for (String price : List.of("0", "-1", "500000")) {
            jdbc.update("UPDATE products SET price = ?, discount = 0 WHERE product_id = 1", price);
            mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isBadRequest());
        }
        verify(provider, never()).create(any(), anyList());
        jdbc.update("UPDATE products SET price = 1.005, discount = 0 WHERE product_id = 1");
        create().andExpect(jsonPath("$.amountTotal").value(202));
    }

    @Test
    void stripeMinimumTotalIsValidatedBeforeStoringOrCallingProvider() throws Exception {
        jdbc.update("UPDATE products SET price = 0.24, discount = 0 WHERE product_id = 1");
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(count("checkouts")).isZero();
        verify(provider, never()).create(any(), anyList());
        jdbc.update("UPDATE products SET price = 0.25 WHERE product_id = 1");
        create().andExpect(jsonPath("$.amountTotal").value(50));
    }

    @Test
    void tamperedSessionIdentityAmountAndCurrencyNeverFinalizeOrRefund() throws Exception {
        create();
        List<Session> sessions = List.of(
            new Session("wrong", null, "complete", "paid", ID, ID, "usd", 19498L, "pi_test"),
            new Session("cs_test", null, "complete", "paid", "wrong", ID, "usd", 19498L, "pi_test"),
            new Session("cs_test", null, "complete", "paid", ID, "wrong", "usd", 19498L, "pi_test"),
            new Session("cs_test", null, "complete", "paid", ID, ID, "eur", 19498L, "pi_test"),
            session(19499, "complete", "paid", "pi_test"),
            session(19498, "open", "paid", "pi_test"),
            session(19498, "complete", "paid", ""));
        for (Session session : sessions) {
            when(provider.retrieve("cs_test")).thenReturn(session);
            complete().andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("PAYMENT_PROVIDER_ERROR"));
        }
        assertThat(count("orders")).isZero();
        verify(provider, never()).refund(anyString(), anyString());
    }

    @Test
    void invalidCheckoutUrlIsNotSaved() throws Exception {
        for (String url : List.of("https://checkout.stripe.com.evil.example/pay",
                "https://checkout.stripe.com:444/pay", "https://user@checkout.stripe.com/pay")) {
            doReturn(new Session("cs_test", url, null, null, null, null, null, null, null))
                .when(provider).create(any(), anyList());
            mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isBadGateway());
        }
        assertThat(repository.require(ID).status()).isEqualTo("creating");
    }

    @Test
    void stockRaceRefundsAfterAtomicRollbackAndRetainsNoOrder() throws Exception {
        create();
        jdbc.update("UPDATE inventory SET quantity_on_hand = 1");
        when(provider.refund(ID, "pi_test")).thenAnswer(invocation -> {
            assertThat(repository.require(ID).status()).isEqualTo("refund_pending");
            assertThat(repository.require(ID).paymentIntentId()).isEqualTo("pi_test");
            assertThat(count("orders")).isZero();
            return true;
        });
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("refunded"));
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("refunded"));
        assertThat(stock()).isEqualTo(1);
        assertThat(count("order_details")).isZero();
        verify(provider, times(1)).refund(ID, "pi_test");
    }

    @Test
    void persistenceFailureRefundFailureRetryNeverCreatesOrder() throws Exception {
        create();
        jdbc.execute("""
            CREATE TRIGGER reject_checkout_order BEFORE UPDATE OF status ON checkouts
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END
            """);
        when(provider.refund(ID, "pi_test")).thenReturn(false);
        complete().andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("REFUND_PENDING"));
        assertThat(repository.require(ID).status()).isEqualTo("refund_pending");
        assertThat(count("orders")).isZero();
        assertThat(stock()).isEqualTo(20);
        jdbc.execute("DROP TRIGGER reject_checkout_order");
        when(provider.refund(ID, "pi_test")).thenThrow(new PaymentException(502, "PAYMENT_PROVIDER_ERROR", "Failed"));
        complete().andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("REFUND_PENDING"));
        doReturn(true).when(provider).refund(ID, "pi_test");
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("refunded"));
        assertThat(count("orders")).isZero();
        verify(provider, times(1)).retrieve("cs_test");
        verify(provider, times(3)).refund(ID, "pi_test");
    }

    @Test
    void partialMultilineOrderAllocationRollsBackBeforeDurableRefundRetry() throws Exception {
        jdbc.update("INSERT INTO inventory(branch_id, product_id, quantity_on_hand) VALUES (1, 2, 20)");
        String multiline = BODY.replace("{\"productId\":1,\"quantity\":2}",
            "{\"productId\":2,\"quantity\":2},{\"productId\":1,\"quantity\":2}");
        mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(multiline))
            .andExpect(status().isOk());
        JsonNode request = json.readTree(repository.require(ID).requestJson());
        assertThat(request.path("items").get(0).path("productId").intValue()).isEqualTo(1);
        jdbc.update("UPDATE inventory SET quantity_on_hand = 1 WHERE product_id = 2");
        doReturn(false).when(provider).refund(ID, "pi_test");
        complete().andExpect(status().isBadGateway()).andExpect(jsonPath("$.error.code").value("REFUND_PENDING"));
        assertThat(stock()).isEqualTo(20);
        assertThat(count("orders")).isZero();
        assertThat(count("order_details")).isZero();
        assertThat(count("inventory_allocations")).isZero();
        jdbc.update("UPDATE inventory SET quantity_on_hand = 20 WHERE product_id = 2");
        doReturn(true).when(provider).refund(ID, "pi_test");
        complete().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("refunded"));
        assertThat(stock()).isEqualTo(20);
        assertThat(count("orders")).isZero();
        verify(provider, times(1)).retrieve("cs_test");
    }

    @Test
    void concurrentFinalizationSerializesAndCannotRefundCompletedOrder() throws Exception {
        create();
        var executor = Executors.newFixedThreadPool(4);
        try {
            List<Callable<Integer>> calls = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                calls.add(() -> complete().andReturn().getResponse().getStatus());
            }
            for (var future : executor.invokeAll(calls)) assertThat(future.get()).isEqualTo(200);
        } finally {
            executor.shutdownNow();
        }
        assertThat(count("orders")).isEqualTo(1);
        assertThat(stock()).isEqualTo(18);
        verify(provider, never()).refund(anyString(), anyString());
    }

    @Test
    void cancelExpiresBeforePersistingAndPaidCancelCompletes() throws Exception {
        create();
        when(provider.retrieve("cs_test")).thenReturn(session(19498, "open", "unpaid", null));
        when(provider.expire("cs_test")).thenAnswer(invocation -> {
            assertThat(repository.require(ID).status()).isEqualTo("pending");
            return session(19498, "expired", "unpaid", null);
        });
        mvc.perform(post("/api/checkout/" + ID + "/cancel"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
        assertThat(stock()).isEqualTo(20);
        jdbc.update("DELETE FROM checkouts");
        create();
        when(provider.retrieve("cs_test")).thenReturn(session(19498, "complete", "paid", "pi_test"));
        mvc.perform(post("/api/checkout/" + ID + "/cancel"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("completed"));
        verify(provider, times(1)).expire("cs_test");
    }

    @Test
    void failedOrUnverifiedCancelRemainsPendingAndMissingLocalNeverCallsProvider() throws Exception {
        complete().andExpect(status().isNotFound());
        verifyNoInteractions(provider);
        create();
        when(provider.retrieve("cs_test")).thenReturn(session(19498, "open", "unpaid", null));
        when(provider.expire("cs_test")).thenThrow(new PaymentException(502, "PAYMENT_PROVIDER_ERROR", "Failed"));
        mvc.perform(post("/api/checkout/" + ID + "/cancel")).andExpect(status().isBadGateway());
        assertThat(repository.require(ID).status()).isEqualTo("pending");
    }

    private org.springframework.test.web.servlet.ResultActions create() throws Exception {
        return mvc.perform(post("/api/checkout").contentType(MediaType.APPLICATION_JSON).content(BODY))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkoutId").value(ID));
    }

    private org.springframework.test.web.servlet.ResultActions complete() throws Exception {
        return mvc.perform(post("/api/checkout/" + ID + "/complete"));
    }

    private Session session(long amount, String status, String paymentStatus, String intent) {
        return new Session("cs_test", "https://checkout.stripe.com/c/pay/test", status, paymentStatus,
            ID, ID, "usd", amount, intent);
    }

    private int count(String table) {
        // Table names are fixed test constants, never request input.
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class);
    }

    private int stock() {
        return jdbc.queryForObject("SELECT quantity_on_hand FROM inventory WHERE branch_id = 1 AND product_id = 1", Integer.class);
    }
}
