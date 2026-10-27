# SQLite Database Integration

This document explains how to use the SQLite database integration in the OctoCAT Supply Chain Management API.

## Overview

The API has been migrated from in-memory data storage to a persistent SQLite database. This provides:

- **Data persistence** - Data survives server restarts
- **ACID transactions** - Reliable data consistency
- **Proper relationships** - Foreign key constraints between entities
- **Performance** - Indexed queries for better performance
- **Testing** - In-memory database for unit tests

## Database Structure

The database consists of the following tables:

- `suppliers` - Supplier information
- `headquarters` - Company headquarters data
- `branches` - Branch locations (linked to headquarters)
- `products` - Product catalog (linked to suppliers)
- `orders` - Customer orders (linked to branches)
- `order_details` - Order line items (linked to orders and products)
- `deliveries` - Delivery tracking (linked to suppliers)
- `order_detail_deliveries` - Junction table for order-delivery relationships
- `migrations` - Database schema version tracking
- `inventory` - Available stock per branch/product (migration 003)
- `inventory_allocations` - Order details whose stock was allocated after migration 003

### Branch inventory

All four APIs use the shared inventory table and allocation triggers. Product reads accept
`?branchId=1` (default 1) and return `quantityOnHand` and `stockStatus`:
`out_of_stock` for zero, `low_stock` for 1-5, and `in_stock` above 5. Missing inventory
records mean zero available, not unlimited stock. Invalid branch IDs return 400; absent
branches return 404.

Fresh demo databases seed 3 units of product 1, zero of product 2, and 20 of each other
product at each branch. **Existing databases are not assigned invented stock on upgrade**:
enter actual counts through the inventory screen/API. Historical order details are not
reallocated during migration.

Set `INVENTORY_ADMIN_TOKEN` in the API process environment to a strong secret before
using `PUT /api/inventory/{branchId}/{productId}`. Send `Authorization: Bearer <token>`
and JSON `{"quantityOnHand": 12}`. Quantities must be integers from 0 to 2147483647.
Unconfigured administration returns 503; missing/incorrect tokens return 403.
Use HTTPS outside local development. No token is checked into source or saved in
browser storage. The existing demonstration login is not server-side authentication;
the token is an independent server-side safeguard for stock changes.

In the UI, sign in with the existing demo admin account pattern and choose **Admin >
Manage Inventory**. Select the branch, enter the administrator token, and save the
physical quantity on hand for each product. The catalogue also allows branch selection
and shows stock counts, including within the product detail view.

To place a complete stock-checked order, `POST /api/orders` with the existing order fields
and an optional non-empty `items` array (up to 100 lines):

```json
{
  "branchId": 1,
  "name": "Branch order",
  "orderDate": "2026-10-27T12:00:00Z",
  "items": [{"productId": 1, "quantity": 2}]
}
```

The server derives discounted unit prices from the catalogue, creates order/details and
decrements stock in one transaction. The response includes persisted `items`. Insufficient
stock returns 409 and rolls back the entire order. Legacy header-only order creation remains
available; legacy detail inserts/updates allocate stock too. Deleting a detail/order restores
its allocation; changing an order's branch while it has details is rejected with 400.
Cancellation/status changes do not currently release stock (order workflow is a separate
backlog feature). Product/branch deletion retains the existing cascade behavior.

Migration runners execute complete trigger definitions rather than splitting at every
semicolon. Back up the database before upgrading. For manual schema rollback, remove the
five `inventory_*` triggers before dropping inventory allocations and inventory; rollback is not an
automatic reversal of historical allocations. Do not edit historical migrations.

## Getting Started

### 1. Database Initialization

When you start the server for the first time, the database will be automatically initialized:

```bash
make dev
```

This will:

- Create the SQLite database file at `api-ts/data/app.db`
- Run all pending migrations
- Seed the database with sample data (if empty)

### 2. Manual Database Management

You can also manage the database manually from the root directory:

```bash
# Initialize database schema (runs migrations)
make db-init

# Seed the database with sample data
make db-seed
```

Alternatively, if you're in the `api-ts/` directory, you can use npm commands directly:

```bash
cd api-ts
npm run db:init
npm run db:seed
```

### 3. Database Location

The database file is stored at:

- **Development**: `api-ts/data/app.db`
- **Testing**: In-memory (`:memory:`)

You can override the database location using the `DB_FILE` environment variable:

```bash
export DB_FILE=/path/to/your/database.db
```

## Repository Pattern

The API uses the Repository pattern to interact with the database:

### Using Repositories

```typescript
import { getSuppliersRepository } from './repositories/suppliersRepo';

const repo = await getSuppliersRepository();

// Get all suppliers
const suppliers = await repo.findAll();

// Get supplier by ID
const supplier = await repo.findById(1);

// Create new supplier
const newSupplier = await repo.create({
    name: 'New Supplier',
    description: 'Description',
    contactPerson: 'John Doe',
    email: 'john@example.com',
    phone: '555-1234'
});

// Update supplier
const updated = await repo.update(1, { name: 'Updated Name' });

// Delete supplier
await repo.delete(1);

// Search by name
const results = await repo.findByName('Tech');
```

### Repository Features

- **Type Safety** - Full TypeScript support
- **Error Handling** - Proper error types (NotFoundError, ValidationError, etc.)
- **SQL Injection Protection** - Parameterized queries
- **Automatic Mapping** - Converts between snake_case (database) and camelCase (JavaScript)

## Database Schema Management

### Migrations

Database schema changes are managed through migration files:

1. Create a new migration file: `src/database/migrations/002_description.sql`
2. Add your SQL statements
3. Run migrations: `make db-init` (or `cd api-ts && npm run db:migrate`)

Migration files are executed in order and tracked in the `migrations` table.

### Seed Data

Sample data is provided through seed files in `src/database/seed/`:

- `001_suppliers.sql` - Supplier data
- `002_headquarters.sql` - Headquarters data
- `003_branches.sql` - Branch data
- `004_products.sql` - Product catalog

## Testing Strategy

### Unit Tests

Repositories are tested using mocked database connections:

```typescript
import { vi } from 'vitest';
import { SuppliersRepository } from '../repositories/suppliersRepo';

// Mock database
const mockDb = {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    close: vi.fn()
};

// Test repository methods
const repo = new SuppliersRepository(mockDb);
```

### Integration Tests

For integration tests, use an in-memory database:

```typescript
import { getDatabase } from '../db/sqlite';

const db = await getDatabase(true); // true = test mode (in-memory)
```

## Configuration

Database configuration is managed in `api-ts/src/db/config.ts`:

```typescript
export const DB_CONFIG = {
    DB_FILE: process.env.DB_FILE || './data/app.db',
    DB_ENGINE: process.env.DB_ENGINE || 'sqlite',
    ENABLE_WAL: process.env.DB_ENABLE_WAL !== 'false',
    TIMEOUT: parseInt(process.env.DB_TIMEOUT || '30000'),
    FOREIGN_KEYS: process.env.DB_FOREIGN_KEYS !== 'false'
};
```

### Environment Variables

- `DB_FILE` - Database file path (default: `./data/app.db`)
- `DB_ENGINE` - Database engine (default: `sqlite`)
- `DB_ENABLE_WAL` - Enable WAL mode (default: `true`)
- `DB_TIMEOUT` - Connection timeout in ms (default: `30000`)
- `DB_FOREIGN_KEYS` - Enable foreign key constraints (default: `true`)

## Error Handling

The system provides specialized error types:

- `DatabaseError` - General database errors
- `NotFoundError` - Entity not found (404)
- `ValidationError` - Invalid data (400)
- `ConflictError` - Constraint violations (409)

These errors are automatically handled by the Express error middleware and return appropriate HTTP status codes.

## Performance Considerations

The database includes several optimizations:

- **Indexes** - On foreign keys and frequently queried columns
- **WAL Mode** - Better concurrency for read/write operations
- **Connection Pooling** - Reuses database connections
- **Query Optimization** - Parameterized queries prevent SQL injection

## Backup and Recovery

Since SQLite stores data in a single file, backup is straightforward:

```bash
# Backup database
cp api-ts/data/app.db api-ts/data/app-backup-$(date +%Y%m%d).db

# Restore from backup
cp api-ts/data/app-backup-20231225.db api-ts/data/app.db
```

For production deployments, consider regular automated backups.

## Troubleshooting

### Common Issues

1. **Database locked**: Usually caused by long-running transactions or unclosed connections
   - Solution: Ensure all database operations are properly awaited and connections are closed

2. **Foreign key constraint errors**: Trying to reference non-existent records
   - Solution: Ensure referenced records exist before creating relationships

3. **Migration errors**: SQL syntax errors or conflicting schema changes
   - Solution: Check migration file syntax and ensure compatibility with existing schema

### Debug Mode

Enable verbose SQLite logging:

```bash
NODE_ENV=development make dev
```

This will show all SQL queries being executed.

## Next Steps

The current implementation includes:

- ✅ Complete SQLite infrastructure
- ✅ Suppliers repository and routes
- ✅ Migration and seeding system
- ✅ Unit tests with mocking

Still to implement:

- [ ] Repositories for remaining entities (products, orders, etc.)
- [ ] Route migration for remaining endpoints
- [ ] Integration tests
- [ ] Docker configuration updates
- [ ] Production deployment considerations
