package com.octocat.supply.model;

public final class ProductModel {
    private ProductModel() {
    }

    public record Product(
        int productId,
        int supplierId,
        String name,
        String description,
        double price,
        String sku,
        String unit,
        String imgName,
        double discount,
        long quantityOnHand
    ) {
        public String getStockStatus() {
            return quantityOnHand == 0 ? "out_of_stock" : quantityOnHand <= 5 ? "low_stock" : "in_stock";
        }
    }

    public record CreateProductRequest(
        Integer supplierId,
        String name,
        String description,
        Double price,
        String sku,
        String unit,
        String imgName,
        Double discount
    ) {
    }

    public record UpdateProductRequest(
        Integer supplierId,
        String name,
        String description,
        Double price,
        String sku,
        String unit,
        String imgName,
        Double discount
    ) {
    }
}
