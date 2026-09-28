type ReadinessCustomer = { agencyName?: string; location?: string; email?: string };
type ReadinessPackage = { status?: string; startDate?: Date | string; endDate?: Date | string; items?: unknown[]; travelerIds?: unknown[] };
type ReadinessOrderItem = { _id?: unknown; description?: string; salePrice?: number; supplierCost?: number };
type ReadinessFulfillment = {
  orderItemId?: unknown;
  supplierName?: string;
  supplierReference?: string;
  supplierInvoiceReference?: string;
  supplierInvoiceAmount?: number;
  status?: string;
};

export function isAccountingLocked(status: unknown): boolean {
  return ["sent", "received", "closed"].includes(String(status || "").toLowerCase());
}

export function getAccountingReadiness(input: {
  customer?: ReadinessCustomer | null;
  package?: ReadinessPackage | null;
  items?: ReadinessOrderItem[];
  fulfillments?: ReadinessFulfillment[];
  currency?: string;
  balance?: number;
  customerPayments?: { paid?: number; pending?: number };
  travelerCount?: number;
}) {
  const blockers: string[] = [];
  const customer = input.customer;
  const pkg = input.package;
  const items = input.items || [];
  const fulfillments = input.fulfillments || [];

  if (!customer?.agencyName?.trim() || !customer.location?.trim() || !customer.email?.trim()) {
    blockers.push("Complete the customer profile name, location, and email");
  }
  if (!Number(input.travelerCount || 0)) blockers.push("Add at least one traveler to the sale");
  if (!pkg || !["confirmed", "completed"].includes(String(pkg.status || "").toLowerCase())) {
    blockers.push("Create and confirm the travel package");
  } else {
    if (!pkg.startDate || !pkg.endDate) blockers.push("Add package travel dates");
    if (!Array.isArray(pkg.items) || pkg.items.length === 0) blockers.push("Add itinerary services to the package");
    if (!Array.isArray(pkg.travelerIds) || pkg.travelerIds.length === 0) blockers.push("Assign at least one traveler to the package");
  }
  if (!input.currency?.trim()) blockers.push("Set the order currency");
  if (!items.length) blockers.push("Add at least one priced service");

  for (const item of items) {
    const label = item.description?.trim() || "Order service";
    if (!Number.isFinite(Number(item.salePrice)) || !Number.isFinite(Number(item.supplierCost))) {
      blockers.push(`Enter selling and supplier cost for ${label}`);
    }
    const fulfillment = fulfillments.find((entry) => String(entry.orderItemId || "") === String(item._id || ""));
    if (!fulfillment) {
      blockers.push(`Add supplier booking details for ${label}`);
      continue;
    }
    if (!fulfillment.supplierName?.trim() || !fulfillment.supplierReference?.trim()) {
      blockers.push(`Record supplier and booking reference for ${label}`);
    }
    if (!fulfillment.supplierInvoiceReference?.trim() || !Number.isFinite(Number(fulfillment.supplierInvoiceAmount))) {
      blockers.push(`Record supplier invoice and actual cost for ${label}`);
    }
    if (!["booked", "completed"].includes(String(fulfillment.status || "").toLowerCase())) {
      blockers.push(`Confirm supplier booking for ${label}`);
    }
  }

  if (Number(input.balance || 0) > 0.009) blockers.push("Settle the customer balance before accounting handoff");
  if (Number(input.customerPayments?.paid || 0) <= 0 || Number(input.customerPayments?.pending || 0) > 0) {
    blockers.push("Record and post the customer payment");
  }

  return { ready: blockers.length === 0, blockers };
}
