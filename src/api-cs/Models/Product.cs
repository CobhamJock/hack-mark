namespace OctoSupply.Api.Models;

public sealed record Product(
    int ProductId,
    int SupplierId,
    string Name,
    string? Description,
    double Price,
    string Sku,
    string Unit,
    string? ImgName,
    double Discount)
{
    public int QuantityOnHand { get; init; }
    public string StockStatus => QuantityOnHand switch
    {
        0 => "out_of_stock",
        <= 5 => "low_stock",
        _ => "in_stock"
    };
}

public sealed class CreateProductRequest
{
    public int SupplierId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public double Price { get; set; }
    public string Sku { get; set; } = string.Empty;
    public string Unit { get; set; } = string.Empty;
    public string? ImgName { get; set; }
    public double Discount { get; set; }
}

public sealed class UpdateProductRequest
{
    public int? SupplierId { get; set; }
    public string? Name { get; set; }
    public string? Description { get; set; }
    public double? Price { get; set; }
    public string? Sku { get; set; }
    public string? Unit { get; set; }
    public string? ImgName { get; set; }
    public double? Discount { get; set; }
}
