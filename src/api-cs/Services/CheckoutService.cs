using System.Text.RegularExpressions;
using OctoSupply.Api.Models;
using OctoSupply.Api.Repositories;
using OctoSupply.Api.Utils;

namespace OctoSupply.Api.Services;

public interface ICheckoutService
{
    Task<CheckoutResponse> CreateAsync(CreateCheckoutRequest request, CancellationToken ct);
    Task<CheckoutResponse> CompleteAsync(string id, CancellationToken ct);
    Task<CheckoutResponse> CancelAsync(string id, CancellationToken ct);
}

public sealed partial class CheckoutService(CheckoutsRepository repository, IPaymentProvider provider) : ICheckoutService
{
    [GeneratedRegex("\\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z")]
    private static partial Regex CheckoutIdPattern();

    private static void ValidateId(string? id)
    {
        if (id is null || !CheckoutIdPattern().IsMatch(id)) throw new ValidationException("checkoutId must be a lowercase UUID v4");
    }

    public async Task<CheckoutResponse> CreateAsync(CreateCheckoutRequest request, CancellationToken ct)
    {
        ValidateId(request.CheckoutId);
        if (request.BranchId <= 0 || request.Items is null || request.Items.Count is < 1 or > 100 ||
            request.Items.Any(i => i is null || i.ProductId <= 0 || i.Quantity <= 0))
            throw new ValidationException("branchId and 1 to 100 positive integer product quantities are required");
        var lines = new List<CheckoutLine>();
        foreach (var group in request.Items.GroupBy(i => i!.ProductId).OrderBy(g => g.Key))
        {
            var quantity = group.Sum(i => (long)i!.Quantity);
            if (quantity > int.MaxValue) throw new ValidationException("Combined quantity exceeds the integer limit");
            lines.Add(new(group.Key, (int)quantity));
        }
        if (await repository.FindAsync(request.CheckoutId!, ct) is null)
            provider.ValidateConfiguration();
        var checkout = await repository.GetOrCreateAsync(request.CheckoutId!, new(request.BranchId, lines), ct);
        if (checkout.Status != "creating") return checkout.Response;
        provider.ValidateConfiguration();
        if (DateTimeOffset.UtcNow - checkout.CreatedAt > TimeSpan.FromHours(23))
            throw new ConflictException("Payment outcome requires reconciliation; checkout cannot be recreated");
        var session = await provider.CreateAsync(checkout, ct);
        if (string.IsNullOrWhiteSpace(session.Id) || !Uri.TryCreate(session.Url, UriKind.Absolute, out var url) ||
            url.GetLeftPart(UriPartial.Authority) != "https://checkout.stripe.com" ||
            !url.IsDefaultPort || !string.IsNullOrEmpty(url.UserInfo) || url.AbsolutePath == "/")
            throw StripePaymentProvider.ProviderError();
        return (await repository.SaveSessionAsync(checkout.CheckoutId, session.Id, session.Url!, ct)).Response;
    }

    private async Task<CheckoutPayment> GetAsync(string id, CancellationToken ct)
    {
        ValidateId(id);
        return await repository.FindAsync(id, ct) ?? throw new ApiException("Checkout not found.", "NOT_FOUND", 404);
    }

    private static void Verify(CheckoutPayment checkout, PaymentSession session)
    {
        if (session.Id != checkout.ProviderSessionId || session.ClientReferenceId != checkout.CheckoutId ||
            session.CheckoutId != checkout.CheckoutId || session.Currency != "usd" || session.AmountTotal != checkout.AmountTotal)
            throw StripePaymentProvider.ProviderError();
    }

    public async Task<CheckoutResponse> CompleteAsync(string id, CancellationToken ct)
    {
        var checkout = await GetAsync(id, ct);
        if (checkout.Status is "completed" or "cancelled" or "refunded") return checkout.Response;
        provider.ValidateConfiguration();
        if (checkout.Status == "refund_pending") return await RefundAsync(checkout, ct);
        if (checkout.ProviderSessionId is null) throw new ConflictException("Checkout session creation must be retried first");
        var session = await provider.RetrieveAsync(checkout.ProviderSessionId, ct);
        Verify(checkout, session);
        if (session.PaymentStatus != "paid")
        {
            if (session.Status == "expired")
                return (await repository.SetStateAsync(id, "pending", "cancelled", ct)).Response;
            throw new ApiException("Payment has not completed.", "PAYMENT_PENDING", 409);
        }
        if (session.Status != "complete" || string.IsNullOrWhiteSpace(session.PaymentIntentId))
            throw StripePaymentProvider.ProviderError();
        checkout = await repository.FinalizeAsync(id, session.PaymentIntentId, ct);
        return checkout.Status == "refund_pending" ? await RefundAsync(checkout, ct) : checkout.Response;
    }

    private async Task<CheckoutResponse> RefundAsync(CheckoutPayment checkout, CancellationToken ct)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(checkout.PaymentIntentId) ||
                !await provider.RefundAsync(checkout.CheckoutId, checkout.PaymentIntentId, ct))
                throw new ApiException("Refund is awaiting reconciliation.", "REFUND_PENDING", 502);
        }
        catch (Exception ex) when (ex is ApiException or HttpRequestException or OperationCanceledException)
        {
            throw new ApiException("Refund is awaiting reconciliation.", "REFUND_PENDING", 502);
        }
        return (await repository.SetStateAsync(checkout.CheckoutId, "refund_pending", "refunded", CancellationToken.None)).Response;
    }

    public async Task<CheckoutResponse> CancelAsync(string id, CancellationToken ct)
    {
        var checkout = await GetAsync(id, ct);
        if (checkout.Status is "completed" or "cancelled" or "refunded") return checkout.Response;
        provider.ValidateConfiguration();
        if (checkout.Status == "refund_pending") return await RefundAsync(checkout, ct);
        if (checkout.ProviderSessionId is null) throw new ConflictException("Checkout session creation must be retried first");
        var session = await provider.RetrieveAsync(checkout.ProviderSessionId, ct);
        Verify(checkout, session);
        if (session.PaymentStatus == "paid") return await CompleteAsync(id, ct);
        if (session.Status == "open")
        {
            session = await provider.ExpireAsync(checkout.ProviderSessionId, ct);
            Verify(checkout, session);
            if (session.PaymentStatus == "paid") return await CompleteAsync(id, ct);
        }
        if (session.Status != "expired") throw StripePaymentProvider.ProviderError();
        return (await repository.SetStateAsync(id, "pending", "cancelled", ct)).Response;
    }
}
