const LEDGER_DERIVED_ORDER_FIELDS = ["amountPaid", "supplierCost"] as const;

export function getLedgerDerivedOrderFields(payload: Record<string, unknown> = {}): string[] {
  return LEDGER_DERIVED_ORDER_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field)
  );
}

export function describeLedgerDerivedOrderFields(fields: string[]): string {
  const explanations: Record<string, string> = {
    amountPaid: "amountPaid is derived from posted customer payments",
    supplierCost: "supplierCost is derived from order service costs and supplier invoices",
  };

  return fields.map((field) => explanations[field] || field).join("; ");
}
