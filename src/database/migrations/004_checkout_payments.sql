CREATE TABLE IF NOT EXISTS checkouts (
    checkout_id TEXT PRIMARY KEY,
    branch_id INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    items_json TEXT NOT NULL,
    amount_total INTEGER NOT NULL CHECK (amount_total > 0),
    currency TEXT NOT NULL CHECK (currency = 'usd'),
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'pending', 'completed', 'refund_pending', 'refunded', 'cancelled')),
    provider_session_id TEXT UNIQUE,
    checkout_url TEXT,
    payment_intent_id TEXT,
    order_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (branch_id) REFERENCES branches(branch_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_checkouts_branch_id ON checkouts(branch_id);
CREATE INDEX IF NOT EXISTS idx_checkouts_status ON checkouts(status);
-- Manual rollback: drop checkouts only after reconciling pending payments/refunds.
