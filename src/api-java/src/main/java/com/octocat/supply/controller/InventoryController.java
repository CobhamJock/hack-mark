package com.octocat.supply.controller;

import com.octocat.supply.exception.InventoryAccessException;
import com.octocat.supply.exception.ValidationException;
import com.octocat.supply.model.InventoryModel.Inventory;
import com.octocat.supply.model.InventoryModel.UpdateInventoryRequest;
import com.octocat.supply.repository.InventoryRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.security.SecurityScheme;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@RestController
@RequestMapping("/api/inventory")
@SecurityScheme(name = "inventoryAdmin", type = SecuritySchemeType.HTTP, scheme = "bearer")
public class InventoryController {
    private final InventoryRepository repository;
    private final String adminToken;

    public InventoryController(InventoryRepository repository, @Value("${INVENTORY_ADMIN_TOKEN:}") String adminToken) {
        this.repository = repository;
        this.adminToken = adminToken;
    }

    @PutMapping("/{branchId}/{productId}")
    @Operation(summary = "Set branch stock (requires INVENTORY_ADMIN_TOKEN)",
        security = @SecurityRequirement(name = "inventoryAdmin"))
    public Inventory update(@PathVariable String branchId, @PathVariable String productId,
                            @RequestHeader(value = "Authorization", required = false) String authorization,
                            @RequestBody UpdateInventoryRequest request) {
        if (adminToken.isBlank()) {
            throw new InventoryAccessException(true);
        }
        if (authorization == null || !authorization.startsWith("Bearer ")
            || !MessageDigest.isEqual(adminToken.getBytes(StandardCharsets.UTF_8),
                authorization.substring(7).getBytes(StandardCharsets.UTF_8))) {
            throw new InventoryAccessException(false);
        }
        int branch = ControllerValidation.positiveId(branchId, "branchId");
        int product = ControllerValidation.positiveId(productId, "productId");
        if (request.quantityOnHand() == null || request.quantityOnHand() < 0) {
            throw new ValidationException("quantityOnHand must be a nonnegative integer");
        }
        return repository.upsert(branch, product, request.quantityOnHand());
    }
}
