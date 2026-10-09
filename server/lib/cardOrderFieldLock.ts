export const POST_CONVERSION_LOCKED_CARD_FIELDS = [
  "paymentStatus",
  "netPaidToHotel",
  "sellToAgency",
  "coveringStatus",
  "serviceOrders",
  "bookingRef",
  "hotelName",
  "supplierName",
  "supplierConfirmationNumber",
  "hotelConfirmationNumber",
  "voucherNumber",
] as const;

function stableJson(value: any): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const plain = typeof value.toObject === "function" ? value.toObject() : value;
    return `{${Object.keys(plain).sort().map((key) => `${JSON.stringify(key)}:${stableJson(plain[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getChangedPostConversionCardFields(
  updates: Record<string, unknown>,
  current: Record<string, unknown>
): string[] {
  return POST_CONVERSION_LOCKED_CARD_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(updates, field)
    && stableJson(updates[field]) !== stableJson(current[field])
  );
}
