package com.octocat.supply.controller;

import com.octocat.supply.exception.NotFoundException;
import com.octocat.supply.model.ProductModel.CreateProductRequest;
import com.octocat.supply.model.ProductModel.Product;
import com.octocat.supply.model.ProductModel.UpdateProductRequest;
import com.octocat.supply.repository.ProductsRepository;
import com.octocat.supply.repository.InventoryRepository;
import io.swagger.v3.oas.annotations.Operation;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/products")
public class ProductsController {
    private final ProductsRepository repository;
    private final InventoryRepository inventory;

    public ProductsController(ProductsRepository repository, InventoryRepository inventory) {
        this.repository = repository;
        this.inventory = inventory;
    }

    @GetMapping
    @Operation(summary = "List products with stock for a branch (default 1)")
    public List<Product> getAll(@RequestParam(required = false) String branchId) {
        int branch = branchId == null ? 1 : ControllerValidation.positiveId(branchId, "branchId");
        inventory.requireBranch(branch);
        return repository.findAll(branch);
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a product with stock for a branch (default 1)")
    public Product getById(@PathVariable int id, @RequestParam(required = false) String branchId) {
        int branch = branchId == null ? 1 : ControllerValidation.positiveId(branchId, "branchId");
        inventory.requireBranch(branch);
        return repository.findById(id, branch).orElseThrow(() -> new NotFoundException("Product not found"));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Product create(@RequestBody CreateProductRequest request) {
        ControllerValidation.requireText(request.name(), "name");
        return repository.create(request);
    }

    @PutMapping("/{id}")
    public Product update(@PathVariable int id, @RequestBody UpdateProductRequest request) {
        repository.findById(id).orElseThrow(() -> new NotFoundException("Product not found"));
        repository.update(id, request);
        return repository.findById(id).orElseThrow(() -> new NotFoundException("Product not found"));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable int id) {
        if (!repository.delete(id)) {
            throw new NotFoundException("Product not found");
        }
    }
}
