export type GateRunnerStatusInput = Readonly<{
  paymentStatus?: unknown;
  status?: unknown;
  checkedIn?: unknown;
  amountPaid?: unknown;
  balanceOwed?: unknown;
}>;

export type EvaluatedRunnerState = Readonly<{
  isConfirmed: boolean;
  isPending: boolean;
  isOwed: boolean;
  isFree: boolean;
  paid: number;
  owed: number;
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

export function evaluateRunnerState(
  runner: GateRunnerStatusInput,
): EvaluatedRunnerState {
  const status = normalizedStatus(runner);
  const paid = safeMoney(runner.amountPaid);
  const owed = safeMoney(runner.balanceOwed);
  const isFree = status === "FREE" || status === "FREE ATTENDEE";
  const isConfirmed =
    status === "CLEARED" ||
    status === "FULLY_CLEARED" ||
    status === "FULLY CLEARED" ||
    status === "CONFIRMED" ||
    status === "✅ CONFIRMED" ||
    /^\[\s*X\s*\]$/u.test(status) ||
    status === "PAID" ||
    isFree ||
    runner.checkedIn === true ||
    (owed === 0 && paid > 0);
  const isOwed = owed > 0 && !isFree;
  const isPending =
    status === "DEPOSIT PAID" ||
    status === "DEPOSIT_PAID" ||
    status === "PENDING" ||
    status === "UNPAID" ||
    isOwed;

  return { isConfirmed, isPending, isOwed, isFree, paid, owed };
}

export function isConfirmedRunner(runner: GateRunnerStatusInput): boolean {
  return evaluateRunnerState(runner).isConfirmed;
}

export function isPendingRunner(runner: GateRunnerStatusInput): boolean {
  return evaluateRunnerState(runner).isPending;
}

export function isOwedRunner(runner: GateRunnerStatusInput): boolean {
  return evaluateRunnerState(runner).isOwed;
}
