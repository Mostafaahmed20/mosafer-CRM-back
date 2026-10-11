export type ClientPaymentVerificationRecord = {
  amount: number;
  currency: string;
  status: string;
  accountantConfirmation?: { confirmedAt?: Date | string };
};

export function getSupplierSubmissionBlocker(input: {
  customerTotal: number;
  currency: string;
  payments: ClientPaymentVerificationRecord[];
}): string | null {
  const currency = String(input.currency || "").toUpperCase();
  const confirmedAmount = input.payments.reduce((total, payment) => {
    if (
      String(payment.status).toLowerCase() !== "posted" ||
      String(payment.currency || "").toUpperCase() !== currency ||
      !payment.accountantConfirmation?.confirmedAt
    ) return total;
    return total + Number(payment.amount || 0);
  }, 0);

  if (confirmedAmount + 0.009 < Number(input.customerTotal || 0)) {
    return "Record the full client transfer and the accountant's WhatsApp confirmation before sending this booking to a supplier";
  }
  return null;
}
