export type GateRunnerStatusInput = Readonly<{
  paymentStatus?: unknown;
  status?: unknown;
  checkedIn?: unknown;
  amountPaid?: unknown;
  balanceOwed?: unknown;
}>;

function normalizedStatus(runner: GateRunnerStatusInput): string {
  return String(runner.paymentStatus || runner.status || "")
    .trim()
    .toLocaleUpperCase("en-US");
}

function safeMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function isConfirmedRunner(runner: GateRunnerStatusInput): boolean {
  const status = normalizedStatus(runner);
  const amountPaid = safeMoney(runner.amountPaid);
  const balanceOwed = safeMoney(runner.balanceOwed);

  return (
    status === "CLEARED" ||
    status === "FULLY_CLEARED" ||
    status === "FULLY CLEARED" ||
    status === "CONFIRMED" ||
    status === "✅ CONFIRMED" ||
    /^\[\s*X\s*\]$/u.test(status) ||
    status === "PAID" ||
    status === "FREE" ||
    status === "FREE ATTENDEE" ||
    runner.checkedIn === true ||
    (balanceOwed === 0 && amountPaid > 0)
  );
}

export function isPendingRunner(runner: GateRunnerStatusInput): boolean {
  const status = normalizedStatus(runner);

  return (
    status === "DEPOSIT PAID" ||
    status === "DEPOSIT_PAID" ||
    status === "PENDING" ||
    status === "UNPAID" ||
    safeMoney(runner.balanceOwed) > 0
  );
}

export function isOwedRunner(runner: GateRunnerStatusInput): boolean {
  return safeMoney(runner.balanceOwed) > 0;
}
