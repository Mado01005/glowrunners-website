import {
  getActiveAttendanceSheetName,
  getAttendanceRoster,
  resolveActiveAttendanceSheetName,
  type AttendanceRosterEntry,
} from "@/lib/googleSheets";
import {
  listGatePayments,
  listGateWalkIns,
} from "@/lib/adminOperations";
import { isConfirmedAttendanceStatus } from "@/lib/attendanceStatus";

const DASHBOARD_CACHE_TTL_MS = 8_000;
const DASHBOARD_STALE_TTL_MS = 2 * 60_000;
let dashboardCache:
  | { loadedAt: number; value: GateDashboardData }
  | undefined;
let dashboardRequest: Promise<GateDashboardData> | undefined;

export type GateDashboardData = Readonly<{
  sheetName: string;
  isFallbackSheet: boolean;
  walkInCount: number;
  confirmed: number;
  pending: number;
  total: number;
  cashInHand: number;
  digitalRevenue: number;
  changeOwed: number;
  owedRunnerRows: readonly number[];
  roster: AttendanceRosterEntry[];
}>;

function isCashPayment(method: string): boolean {
  return method
    .trim()
    .toLocaleLowerCase("en-US") === "cash";
}

export function emptyGateDashboard(
  sheetName = getActiveAttendanceSheetName(),
): GateDashboardData {
  return {
    sheetName,
    isFallbackSheet: false,
    walkInCount: 0,
    confirmed: 0,
    pending: 0,
    total: 0,
    cashInHand: 0,
    digitalRevenue: 0,
    changeOwed: 0,
    owedRunnerRows: [],
    roster: [],
  };
}

export function isMissingAttendanceDataError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLocaleLowerCase("en-US");

  return [
    "unable to parse range",
    "requested entity was not found",
    "sheet not found",
    "no grid with id",
    "does not exist",
  ].some((fragment) => message.includes(fragment));
}

export function isRateLimitedSheetsError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLocaleLowerCase("en-US");

  return (
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("status 429")
  );
}

export function invalidateGateDashboardCache(): void {
  dashboardCache = undefined;
  dashboardRequest = undefined;
}

async function loadGateDashboardData(): Promise<GateDashboardData> {
  const { sheetName, isFallback } = await resolveActiveAttendanceSheetName();
  const [roster, payments, walkIns] = await Promise.all([
    getAttendanceRoster(sheetName),
    listGatePayments(sheetName),
    listGateWalkIns(sheetName),
  ]);
  const confirmedRows = new Set(
    roster
      .filter((runner) => isConfirmedAttendanceStatus(runner.status))
      .map((runner) => runner.rowIndex),
  );
  const seenPaymentRows = new Set<number>();
  const confirmedPayments = payments.filter((payment) => {
    if (
      !confirmedRows.has(payment.runnerRow) ||
      seenPaymentRows.has(payment.runnerRow)
    ) {
      return false;
    }

    seenPaymentRows.add(payment.runnerRow);
    return true;
  });
  const cashInHand = confirmedPayments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? payment.amountReceivedEgp
        : 0),
    walkIns.reduce(
      (sum, walkIn) =>
        sum +
        (isCashPayment(walkIn.paymentMethod) ? walkIn.amountPaidEgp : 0),
      0,
    ),
  );
  const digitalRevenue = confirmedPayments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? 0
        : payment.amountReceivedEgp),
    walkIns.reduce(
      (sum, walkIn) =>
        sum +
        (isCashPayment(walkIn.paymentMethod) ? 0 : walkIn.amountPaidEgp),
      0,
    ),
  );
  const changeOwed = confirmedPayments.reduce(
    (sum, payment) => sum + payment.changeOwedEgp,
    walkIns.reduce((sum, walkIn) => sum + walkIn.changeOwedEgp, 0),
  );
  const owedRunnerRows = [
    ...new Set(
      confirmedPayments
        .filter((payment) => payment.changeOwedEgp > 0)
        .map((payment) => payment.runnerRow),
    ),
  ];

  return {
    sheetName,
    isFallbackSheet: isFallback,
    walkInCount: walkIns.length,
    confirmed: confirmedRows.size + walkIns.length,
    pending: Math.max(0, roster.length - confirmedRows.size),
    total: roster.length + walkIns.length,
    cashInHand,
    digitalRevenue,
    changeOwed,
    owedRunnerRows,
    roster,
  };
}

export async function getGateDashboardData(): Promise<GateDashboardData> {
  const now = Date.now();

  if (
    dashboardCache &&
    now - dashboardCache.loadedAt < DASHBOARD_CACHE_TTL_MS
  ) {
    return dashboardCache.value;
  }

  if (!dashboardRequest) {
    dashboardRequest = loadGateDashboardData()
      .then((value) => {
        dashboardCache = { loadedAt: Date.now(), value };
        return value;
      })
      .catch((error: unknown) => {
        if (
          dashboardCache &&
          Date.now() - dashboardCache.loadedAt < DASHBOARD_STALE_TTL_MS &&
          isRateLimitedSheetsError(error)
        ) {
          return dashboardCache.value;
        }

        throw error;
      })
      .finally(() => {
        dashboardRequest = undefined;
      });
  }

  return dashboardRequest;
}
