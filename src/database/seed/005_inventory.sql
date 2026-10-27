-- Deterministic demo availability: product 1 is low, product 2 is unavailable.
INSERT INTO inventory (branch_id, product_id, quantity_on_hand)
SELECT b.branch_id, p.product_id,
    CASE WHEN p.product_id = 1 THEN 3 WHEN p.product_id = 2 THEN 0 ELSE 20 END
FROM branches b CROSS JOIN products p;
