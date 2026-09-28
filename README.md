# Initial-CRM-ops-implementation

# travel-crm-backend

## Supplier Reference Uniqueness

From the `crm-server` workspace root, stop API instances that write fulfillment records, then run `pnpm run migrate:order-fulfillment-references` after deploying fulfillment reference or service-link uniqueness changes. The migration reports active booking or unresolved financial-link conflicts and exits before index changes when collisions need review. Resolve those records, then rerun it to backfill normalized supplier-reference keys and rebuild both unique indexes. Supplier invoice amounts are pre-tax actual costs attached to one order service; they replace that service's estimate in the order supplier-cost total. Supplier payments are append-only fulfillment entries; partial payments cannot exceed the invoice balance, and recorded payments prevent invoice identity or service-link changes.
