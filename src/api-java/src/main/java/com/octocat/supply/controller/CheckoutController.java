package com.octocat.supply.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.octocat.supply.exception.ValidationException;
import com.octocat.supply.model.CheckoutModel.*;
import com.octocat.supply.service.CheckoutService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.Map;
import java.util.TreeMap;

@RestController
@RequestMapping("/api/checkout")
@Tag(name = "Checkout", description = "Server-priced USD Stripe checkout; UUID v4 is a private capability")
public class CheckoutController {
    private final CheckoutService service;

    public CheckoutController(CheckoutService service) {
        this.service = service;
    }

    @PostMapping
    @Operation(summary = "Create or resume an idempotent checkout",
        description = "At most 100 integer item lines; duplicates combine. Different requests for the same ID return 409.",
        requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true,
            content = @Content(schema = @Schema(implementation = CheckoutInput.class))))
    @ApiResponse(responseCode = "200", description = "Durable checkout")
    @ApiResponse(responseCode = "400", description = "VALIDATION_ERROR")
    @ApiResponse(responseCode = "404", description = "NOT_FOUND")
    @ApiResponse(responseCode = "409", description = "CONFLICT or reconciliation required")
    @ApiResponse(responseCode = "503", description = "PAYMENT_UNAVAILABLE")
    @ApiResponse(responseCode = "502", description = "PAYMENT_PROVIDER_ERROR")
    public Response create(@RequestBody JsonNode body) {
        if (!body.isObject() || !body.path("checkoutId").isTextual()) {
            throw invalid();
        }
        String id = validateId(body.path("checkoutId").textValue());
        int branchId = positive(body.path("branchId"));
        JsonNode lines = body.path("items");
        if (!lines.isArray() || lines.isEmpty() || lines.size() > 100) {
            throw invalid();
        }
        Map<Integer, Integer> quantities = new TreeMap<>();
        for (JsonNode line : lines) {
            int product = positive(line.path("productId"));
            int quantity = positive(line.path("quantity"));
            long combined = (long) quantities.getOrDefault(product, 0) + quantity;
            if (combined > Integer.MAX_VALUE) {
                throw invalid();
            }
            quantities.put(product, (int) combined);
        }
        ArrayList<Item> items = new ArrayList<>();
        quantities.forEach((product, quantity) -> items.add(new Item(product, quantity)));
        return service.create(id, new Request(branchId, items));
    }

    @PostMapping("/{id}/complete")
    @Operation(summary = "Verify payment server-side and atomically finalize or retry refund")
    @ApiResponse(responseCode = "409", description = "PAYMENT_PENDING or CONFLICT")
    @ApiResponse(responseCode = "502", description = "PAYMENT_PROVIDER_ERROR or REFUND_PENDING")
    public Response complete(@PathVariable String id) {
        return service.complete(validateId(id));
    }

    @PostMapping("/{id}/cancel")
    @Operation(summary = "Expire unpaid checkout; paid sessions finalize instead")
    public Response cancel(@PathVariable String id) {
        return service.cancel(validateId(id));
    }

    private static String validateId(String id) {
        if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) {
            throw invalid();
        }
        return id;
    }

    private static int positive(JsonNode value) {
        if (!value.isIntegralNumber() || !value.canConvertToInt() || value.intValue() <= 0) {
            throw invalid();
        }
        return value.intValue();
    }

    private static ValidationException invalid() {
        return new ValidationException("Expected lowercase UUID v4, positive integer IDs and 1-100 positive integer item lines");
    }

    public record CheckoutInput(
        @Schema(format = "uuid", example = "c1ac6c82-ad98-41d0-a6fa-72effe62e97e") String checkoutId,
        @Schema(minimum = "1", maximum = "2147483647") int branchId,
        java.util.List<Item> items) {}
}
