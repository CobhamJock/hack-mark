package com.octocat.supply.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSetter;
import com.fasterxml.jackson.annotation.Nulls;
import com.octocat.supply.model.OrderDetailModel.OrderDetail;

import java.util.List;

public final class OrderModel {
    private OrderModel() {
    }

    public record Order(
        int orderId,
        int branchId,
        String orderDate,
        String name,
        String description,
        String status,
        @JsonInclude(JsonInclude.Include.NON_NULL) List<OrderDetail> items
    ) {
        public Order(int orderId, int branchId, String orderDate, String name, String description, String status) {
            this(orderId, branchId, orderDate, name, description, status, null);
        }
    }

    public record OrderItemRequest(Integer productId, Integer quantity) {
    }

    public static final class CreateOrderRequest {
        @JsonProperty
        private Integer branchId;
        @JsonProperty
        private String orderDate;
        @JsonProperty
        private String name;
        @JsonProperty
        private String description;
        @JsonProperty
        private String status;
        @JsonProperty
        @JsonSetter(nulls = Nulls.FAIL)
        private List<OrderItemRequest> items;

        public Integer branchId() {
            return branchId;
        }

        public String orderDate() {
            return orderDate;
        }

        public String name() {
            return name;
        }

        public String description() {
            return description;
        }

        public String status() {
            return status;
        }

        public List<OrderItemRequest> items() {
            return items;
        }
    }

    public record UpdateOrderRequest(
        Integer branchId,
        String orderDate,
        String name,
        String description,
        String status
    ) {
    }
}
