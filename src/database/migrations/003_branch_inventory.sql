-- Stock starts at zero for existing databases. Staff must enter actual on-hand counts.
CREATE TABLE IF NOT EXISTS inventory (
    branch_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_on_hand) = 'integer' AND quantity_on_hand >= 0),
    PRIMARY KEY (branch_id, product_id),
    FOREIGN KEY (branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE ON UPDATE RESTRICT,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_inventory_product_id ON inventory(product_id);

-- Only allocations made after this migration may be returned to available stock.
CREATE TABLE IF NOT EXISTS inventory_allocations (
    order_detail_id INTEGER PRIMARY KEY,
    FOREIGN KEY (order_detail_id) REFERENCES order_details(order_detail_id) ON DELETE CASCADE ON UPDATE RESTRICT
);

-- Enforce stock on every write path, including legacy order-detail endpoints.
CREATE TRIGGER IF NOT EXISTS inventory_detail_insert
AFTER INSERT ON order_details
BEGIN
    SELECT RAISE(ABORT, 'Quantity must be a positive integer')
    WHERE typeof(NEW.quantity) != 'integer' OR NEW.quantity <= 0;
    SELECT RAISE(ABORT, 'Insufficient stock')
    WHERE COALESCE((SELECT quantity_on_hand FROM inventory
        WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = NEW.order_id)
        AND product_id = NEW.product_id), 0) < NEW.quantity;
    UPDATE inventory SET quantity_on_hand = quantity_on_hand - NEW.quantity
    WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = NEW.order_id)
    AND product_id = NEW.product_id;
    INSERT INTO inventory_allocations (order_detail_id) VALUES (NEW.order_detail_id);
END;

CREATE TRIGGER IF NOT EXISTS inventory_detail_update
AFTER UPDATE OF quantity, product_id, order_id ON order_details
BEGIN
    SELECT RAISE(ABORT, 'Quantity must be a positive integer')
    WHERE typeof(NEW.quantity) != 'integer' OR NEW.quantity <= 0;
    UPDATE inventory SET quantity_on_hand = quantity_on_hand + OLD.quantity
    WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = OLD.order_id)
    AND product_id = OLD.product_id
    AND EXISTS (SELECT 1 FROM inventory_allocations WHERE order_detail_id = OLD.order_detail_id);
    SELECT RAISE(ABORT, 'Insufficient stock')
    WHERE COALESCE((SELECT quantity_on_hand FROM inventory
        WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = NEW.order_id)
        AND product_id = NEW.product_id), 0) < NEW.quantity;
    UPDATE inventory SET quantity_on_hand = quantity_on_hand - NEW.quantity
    WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = NEW.order_id)
    AND product_id = NEW.product_id;
    INSERT OR IGNORE INTO inventory_allocations (order_detail_id) VALUES (NEW.order_detail_id);
END;

CREATE TRIGGER IF NOT EXISTS inventory_detail_delete
BEFORE DELETE ON order_details
BEGIN
    UPDATE inventory SET quantity_on_hand = quantity_on_hand + OLD.quantity
    WHERE branch_id = (SELECT branch_id FROM orders WHERE order_id = OLD.order_id)
    AND product_id = OLD.product_id
    AND EXISTS (SELECT 1 FROM inventory_allocations WHERE order_detail_id = OLD.order_detail_id);
END;

CREATE TRIGGER IF NOT EXISTS inventory_order_delete
BEFORE DELETE ON orders
BEGIN
    UPDATE inventory SET quantity_on_hand = quantity_on_hand +
        (SELECT SUM(quantity) FROM order_details d JOIN inventory_allocations a USING(order_detail_id)
         WHERE d.order_id = OLD.order_id AND d.product_id = inventory.product_id)
    WHERE branch_id = OLD.branch_id
    AND product_id IN (SELECT d.product_id FROM order_details d JOIN inventory_allocations a USING(order_detail_id)
        WHERE d.order_id = OLD.order_id);
END;

CREATE TRIGGER IF NOT EXISTS inventory_order_branch_update
BEFORE UPDATE OF branch_id ON orders
WHEN NEW.branch_id != OLD.branch_id AND EXISTS (SELECT 1 FROM order_details WHERE order_id = OLD.order_id)
BEGIN
    SELECT RAISE(ABORT, 'Cannot change branch of an order with items');
END;

-- Rollback: drop the five inventory_* triggers, then inventory_allocations and inventory.
-- Do not automatically reverse stock allocations for previously persisted orders.
