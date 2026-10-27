package com.octocat.supply.controller;

import com.octocat.supply.exception.NotFoundException;
import com.octocat.supply.exception.ValidationException;
import com.octocat.supply.model.OrderModel.CreateOrderRequest;
import com.octocat.supply.model.OrderModel.Order;
import com.octocat.supply.model.OrderModel.UpdateOrderRequest;
import com.octocat.supply.repository.OrdersRepository;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;

import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrdersController {
    private final OrdersRepository repository;

    public OrdersController(OrdersRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public List<Order> getAll() {
        return repository.findAll();
    }

    @GetMapping("/{id}")
    public Order getById(@PathVariable int id) {
        return repository.findById(id).orElseThrow(() -> new NotFoundException("Order not found"));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Create an order, optionally allocating 1–100 stock items at server prices",
        description = "Items require positive integer productId and quantity. Insufficient stock returns 409 and rolls back the entire order.")
    public Order create(@RequestBody CreateOrderRequest request) {
        ControllerValidation.requireText(request.name(), "name");
        ControllerValidation.requirePositive(request.branchId(), "branchId");
        if (request.items() != null) {
            if (request.items().isEmpty() || request.items().size() > 100) {
                throw new ValidationException("items must contain between 1 and 100 lines");
            }
            for (var item : request.items()) {
                if (item == null) {
                    throw new ValidationException("items must contain productId and quantity");
                }
                ControllerValidation.requirePositive(item.productId(), "productId");
                ControllerValidation.requirePositive(item.quantity(), "quantity");
            }
        }
        return repository.create(request);
    }

    @PutMapping("/{id}")
    public Order update(@PathVariable int id, @RequestBody UpdateOrderRequest request) {
        if (request.branchId() != null) {
            ControllerValidation.requirePositive(request.branchId(), "branchId");
        }
        repository.findById(id).orElseThrow(() -> new NotFoundException("Order not found"));
        repository.update(id, request);
        return repository.findById(id).orElseThrow(() -> new NotFoundException("Order not found"));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable int id) {
        if (!repository.delete(id)) {
            throw new NotFoundException("Order not found");
        }
    }
}
