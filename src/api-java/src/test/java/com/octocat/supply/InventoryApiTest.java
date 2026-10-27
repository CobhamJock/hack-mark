package com.octocat.supply;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.octocat.supply.exception.GlobalExceptionHandler;
import com.octocat.supply.controller.InventoryController;
import com.octocat.supply.repository.InventoryRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
    "INVENTORY_ADMIN_TOKEN=test-inventory-admin",
    "app.db-file=./target/test-data/inventory.db"
})
@AutoConfigureMockMvc
class InventoryApiTest {
    @Autowired
    private MockMvc mvc;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private ObjectMapper json;

    @BeforeEach
    void resetStockAndOrders() {
        jdbc.update("DELETE FROM order_detail_deliveries");
        jdbc.update("DELETE FROM order_details");
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM inventory");
    }

    @ParameterizedTest
    @CsvSource({"0,out_of_stock", "1,low_stock", "5,low_stock", "6,in_stock"})
    void stockReadsPreserveProductFieldsAndUseBranch(int quantity, String stockStatus) throws Exception {
        stock(1, 1, quantity);
        stock(2, 1, 19);
        mvc.perform(get("/api/products"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].productId").value(1))
            .andExpect(jsonPath("$[0].price").value(129.99))
            .andExpect(jsonPath("$[0].quantityOnHand").value(quantity))
            .andExpect(jsonPath("$[0].stockStatus").value(stockStatus));
        mvc.perform(get("/api/products/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.quantityOnHand").value(quantity))
            .andExpect(jsonPath("$.stockStatus").value(stockStatus));
        mvc.perform(get("/api/products/1").param("branchId", "2"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.quantityOnHand").value(19))
            .andExpect(jsonPath("$.stockStatus").value("in_stock"));
        mvc.perform(get("/api/products/2"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.quantityOnHand").value(0))
            .andExpect(jsonPath("$.stockStatus").value("out_of_stock"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "-1", "1.5", "true", "2147483648", "one", ""})
    void invalidBranchQueriesReturnValidationErrors(String branch) throws Exception {
        for (String endpoint : new String[]{"/api/products", "/api/products/1"}) {
            mvc.perform(get(endpoint).param("branchId", branch))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        }
    }

    @Test
    void missingBranchesAndProductsReturn404() throws Exception {
        for (String endpoint : new String[]{"/api/products", "/api/products/1"}) {
            mvc.perform(get(endpoint).param("branchId", "99999"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
        }
        mvc.perform(get("/api/products/99999")).andExpect(status().isNotFound());
        for (String endpoint : new String[]{"/api/inventory/99999/1", "/api/inventory/1/99999"}) {
            mvc.perform(put(endpoint).header("Authorization", "Bearer test-inventory-admin")
                    .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":4}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
        }
    }

    @Test
    void inventoryRequiresAuthorizationAndUpsertsIncludingZeroAndMaximum() throws Exception {
        mvc.perform(put("/api/inventory/1/1").contentType(MediaType.APPLICATION_JSON)
                .content("{\"quantityOnHand\":7}"))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        for (String token : new String[]{"Bearer wrong", "Basic test-inventory-admin", "Bearer test-inventory-admin extra"}) {
            mvc.perform(put("/api/inventory/1/1").header("Authorization", token)
                    .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":7}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.message").value("Inventory administrator authorization required"));
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory", Integer.class)).isZero();
        for (int quantity : new int[]{7, 0, Integer.MAX_VALUE}) {
            mvc.perform(put("/api/inventory/1/1").header("Authorization", "Bearer test-inventory-admin")
                    .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":" + quantity + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.branchId").value(1))
                .andExpect(jsonPath("$.productId").value(1))
                .andExpect(jsonPath("$.quantityOnHand").value(quantity));
            assertThat(quantity(1, 1)).isEqualTo(quantity);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory", Integer.class)).isEqualTo(1);
    }

    @Test
    void unconfiguredInventoryAdministrationIsUnavailableAndDoesNotWrite() throws Exception {
        InventoryRepository repository = mock(InventoryRepository.class);
        MockMvc standalone = MockMvcBuilders.standaloneSetup(new InventoryController(repository, ""))
            .setControllerAdvice(new GlobalExceptionHandler()).build();
        standalone.perform(put("/api/inventory/1/1").header("Authorization", "Bearer anything")
                .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":1}"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.error.code").value("SERVICE_UNAVAILABLE"))
            .andExpect(jsonPath("$.error.message").value("Inventory administration is unavailable"));
        verifyNoInteractions(repository);
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "1.5", "1.0", "\"2\"", "true", "2147483648", "null", "[]", "{}"})
    void inventoryRejectsNonIntegerOrInvalidQuantities(String quantity) throws Exception {
        mvc.perform(put("/api/inventory/1/1").header("Authorization", "Bearer test-inventory-admin")
                .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":" + quantity + "}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory", Integer.class)).isZero();
    }

    @Test
    void inventoryRejectsMissingQuantityAndInvalidIds() throws Exception {
        mvc.perform(put("/api/inventory/1/1").header("Authorization", "Bearer test-inventory-admin")
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isBadRequest());
        for (String endpoint : new String[]{"/api/inventory/0/1", "/api/inventory/1/-1",
            "/api/inventory/1.5/1", "/api/inventory/1/2147483648"}) {
            mvc.perform(put(endpoint).header("Authorization", "Bearer test-inventory-admin")
                    .contentType(MediaType.APPLICATION_JSON).content("{\"quantityOnHand\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        }
    }

    @Test
    void orderWithItemsPersistsServerPricesAndAllocatesOnlyItsBranch() throws Exception {
        stock(1, 1, 10);
        stock(1, 2, 8);
        stock(2, 1, 20);
        JsonNode order = createOrder("""
            [{"productId":1,"quantity":2,"unitPrice":0.01},{"productId":2,"quantity":3}]
            """, 201);
        assertThat(order.path("items").size()).isEqualTo(2);
        assertThat(order.at("/items/0/unitPrice").asDouble()).isEqualTo(97.49);
        assertThat(order.at("/items/1/unitPrice").asDouble()).isEqualTo(149.99);
        int orderId = order.path("orderId").asInt();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM order_details WHERE order_id = ?", Integer.class, orderId))
            .isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT unit_price FROM order_details WHERE order_detail_id = ?",
            Double.class, order.at("/items/0/orderDetailId").asInt())).isEqualTo(97.49);
        assertThat(quantity(1, 1)).isEqualTo(8);
        assertThat(quantity(1, 2)).isEqualTo(5);
        assertThat(quantity(2, 1)).isEqualTo(20);
        mvc.perform(get("/api/order-details/" + order.at("/items/0/orderDetailId").asInt()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.unitPrice").value(97.49));
    }

    @Test
    void insufficientLaterItemRollsBackHeaderDetailsAndEarlierDecrement() throws Exception {
        stock(1, 1, 5);
        stock(1, 2, 1);
        JsonNode response = createOrder("[{\"productId\":1,\"quantity\":2},{\"productId\":2,\"quantity\":2}]", 409);
        assertThat(response.at("/error/code").asText()).isEqualTo("CONFLICT");
        assertThat(response.at("/error/message").asText()).isEqualTo("Insufficient stock");
        assertNoOrders();
        assertThat(quantity(1, 1)).isEqualTo(5);
        assertThat(quantity(1, 2)).isEqualTo(1);
        createOrder("[{\"productId\":3,\"quantity\":1}]", 409);
        assertNoOrders();
    }

    @Test
    void duplicateProductLinesCannotOversellAndRollbackTogether() throws Exception {
        stock(1, 1, 3);
        createOrder("[{\"productId\":1,\"quantity\":2},{\"productId\":1,\"quantity\":2}]", 409);
        assertNoOrders();
        assertThat(quantity(1, 1)).isEqualTo(3);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "[]", "null", "[null]", "[{}]", "[{\"productId\":0,\"quantity\":1}]",
        "[{\"productId\":-1,\"quantity\":1}]", "[{\"productId\":\"1\",\"quantity\":1}]",
        "[{\"productId\":true,\"quantity\":1}]", "[{\"productId\":1.0,\"quantity\":1}]",
        "[{\"productId\":2147483648,\"quantity\":1}]", "[{\"productId\":1,\"quantity\":0}]",
        "[{\"productId\":1,\"quantity\":-1}]", "[{\"productId\":1,\"quantity\":1.5}]",
        "[{\"productId\":1,\"quantity\":1.0}]", "[{\"productId\":1,\"quantity\":\"1\"}]",
        "[{\"productId\":1,\"quantity\":true}]", "[{\"productId\":1,\"quantity\":2147483648}]"
    })
    void invalidOrderItemsAreRejectedBeforeWriting(String items) throws Exception {
        JsonNode response = createOrder(items, 400);
        assertThat(response.at("/error/code").asText()).isEqualTo("VALIDATION_ERROR");
        assertNoOrders();
    }

    @Test
    void orderLineLimitAndMissingReferencesAreEnforced() throws Exception {
        String item = "{\"productId\":1,\"quantity\":1}";
        createOrder("[" + String.join(",", java.util.Collections.nCopies(101, item)) + "]", 400);
        assertNoOrders();
        createOrder("[{\"productId\":99999,\"quantity\":1}]", 404);
        mvc.perform(post("/api/orders").contentType(MediaType.APPLICATION_JSON).content("""
            {"branchId":99999,"name":"Missing branch","orderDate":"2026-10-27",
             "items":[{"productId":1,"quantity":1}]}
            """)).andExpect(status().isNotFound());
        assertNoOrders();
        stock(1, 1, 100);
        assertThat(createOrder("[" + String.join(",", java.util.Collections.nCopies(100, item)) + "]", 201)
            .path("items").size()).isEqualTo(100);
        assertThat(quantity(1, 1)).isZero();
    }

    @Test
    void headerOnlyOrdersAndLegacyDetailCrudRespectStockAndBranchProtection() throws Exception {
        stock(1, 1, 5);
        int orderId = headerOrder(1);
        String body = "{\"orderId\":" + orderId + ",\"productId\":1,\"quantity\":2}";
        String created = mvc.perform(post("/api/order-details").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.unitPrice").value(97.49))
            .andReturn().getResponse().getContentAsString();
        int detailId = json.readTree(created).path("orderDetailId").asInt();
        assertThat(quantity(1, 1)).isEqualTo(3);
        mvc.perform(put("/api/order-details/" + detailId).contentType(MediaType.APPLICATION_JSON).content("{\"quantity\":6}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("CONFLICT"));
        assertThat(quantity(1, 1)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT quantity FROM order_details WHERE order_detail_id = ?", Integer.class, detailId))
            .isEqualTo(2);
        mvc.perform(put("/api/orders/" + orderId).contentType(MediaType.APPLICATION_JSON).content("{\"branchId\":2}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
            .andExpect(jsonPath("$.error.message").value("Cannot change branch of an order with items"));
        mvc.perform(put("/api/order-details/" + detailId).contentType(MediaType.APPLICATION_JSON).content("{\"quantity\":1}"))
            .andExpect(status().isOk());
        assertThat(quantity(1, 1)).isEqualTo(4);
        mvc.perform(delete("/api/order-details/" + detailId)).andExpect(status().isNoContent());
        assertThat(quantity(1, 1)).isEqualTo(5);
        mvc.perform(post("/api/order-details").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated());
        mvc.perform(delete("/api/orders/" + orderId)).andExpect(status().isNoContent());
        assertThat(quantity(1, 1)).isEqualTo(5);
        assertNoOrders();
    }

    @Test
    void legacyDetailMovesRefundOldBranchAndAllocateNewBranchAtomically() throws Exception {
        stock(1, 1, 5);
        stock(2, 1, 1);
        int first = headerOrder(1);
        int second = headerOrder(2);
        String created = mvc.perform(post("/api/order-details").contentType(MediaType.APPLICATION_JSON)
                .content("{\"orderId\":" + first + ",\"productId\":1,\"quantity\":2}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        int detail = json.readTree(created).path("orderDetailId").asInt();
        mvc.perform(put("/api/order-details/" + detail).contentType(MediaType.APPLICATION_JSON)
                .content("{\"orderId\":" + second + "}"))
            .andExpect(status().isConflict());
        assertThat(quantity(1, 1)).isEqualTo(3);
        assertThat(quantity(2, 1)).isEqualTo(1);
        mvc.perform(put("/api/order-details/" + detail).contentType(MediaType.APPLICATION_JSON)
                .content("{\"orderId\":" + second + ",\"quantity\":1}"))
            .andExpect(status().isOk());
        assertThat(quantity(1, 1)).isEqualTo(5);
        assertThat(quantity(2, 1)).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "-1", "1.5", "1.0", "\"1\"", "true", "null", "2147483648"})
    void legacyDetailCreateRejectsInvalidQuantities(String quantity) throws Exception {
        int order = headerOrder(1);
        mvc.perform(post("/api/order-details").contentType(MediaType.APPLICATION_JSON)
                .content("{\"orderId\":" + order + ",\"productId\":1,\"quantity\":" + quantity + "}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM order_details", Integer.class)).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "-1", "1.5", "1.0", "\"1\"", "true", "2147483648"})
    void legacyDetailUpdateRejectsInvalidQuantitiesWithoutChangingStock(String quantity) throws Exception {
        stock(1, 1, 5);
        JsonNode order = createOrder("[{\"productId\":1,\"quantity\":2}]", 201);
        int detail = order.at("/items/0/orderDetailId").asInt();
        mvc.perform(put("/api/order-details/" + detail).contentType(MediaType.APPLICATION_JSON)
                .content("{\"quantity\":" + quantity + "}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(quantity(1, 1)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT quantity FROM order_details WHERE order_detail_id = ?", Integer.class, detail))
            .isEqualTo(2);
    }

    @Test
    void maximumIntegerQuantityIsAcceptedAndRefundReadsDoNotOverflow() throws Exception {
        stock(1, 1, Integer.MAX_VALUE);
        JsonNode order = createOrder("[{\"productId\":1,\"quantity\":2147483647}]", 201);
        assertThat(order.at("/items/0/quantity").asInt()).isEqualTo(Integer.MAX_VALUE);
        assertThat(quantity(1, 1)).isZero();
        jdbc.update("UPDATE inventory SET quantity_on_hand = 1 WHERE branch_id = 1 AND product_id = 1");
        mvc.perform(delete("/api/orders/" + order.path("orderId").asInt())).andExpect(status().isNoContent());
        mvc.perform(get("/api/products/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.quantityOnHand").value(2147483648L))
            .andExpect(jsonPath("$.stockStatus").value("in_stock"));
    }

    private JsonNode createOrder(String items, int expectedStatus) throws Exception {
        String response = mvc.perform(post("/api/orders").contentType(MediaType.APPLICATION_JSON)
                .content("{\"branchId\":1,\"name\":\"Stock order\",\"orderDate\":\"2026-10-27\",\"items\":" + items + "}"))
            .andExpect(status().is(expectedStatus)).andReturn().getResponse().getContentAsString();
        return json.readTree(response);
    }

    private int headerOrder(int branch) throws Exception {
        String response = mvc.perform(post("/api/orders").contentType(MediaType.APPLICATION_JSON)
                .content("{\"branchId\":" + branch + ",\"name\":\"Legacy\",\"orderDate\":\"2026-10-27\"}"))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.items").doesNotExist())
            .andReturn().getResponse().getContentAsString();
        return json.readTree(response).path("orderId").asInt();
    }

    private void stock(int branch, int product, int quantity) {
        jdbc.update("INSERT INTO inventory (branch_id, product_id, quantity_on_hand) VALUES (?, ?, ?)",
            branch, product, quantity);
    }

    private int quantity(int branch, int product) {
        return jdbc.queryForObject("SELECT quantity_on_hand FROM inventory WHERE branch_id = ? AND product_id = ?",
            Integer.class, branch, product);
    }

    private void assertNoOrders() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM order_details", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM inventory_allocations", Integer.class)).isZero();
    }
}
