import {
  getActiveAttendanceSheetName,
  getAttendanceRoster,
  resolveActiveAttendanceSheetName,
  type AttendanceRosterEntry,
} from "@/lib/googleSheets";
import { listGatePayments } from "@/lib/adminOperations";

const DASHBOARD_CACHE_TTL_MS = 8_000;
const DASHBOARD_STALE_TTL_MS = 2 * 60_000;
let dashboardCache:
  | { loadedAt: number; value: GateDashboardData }
  | undefined;
let dashboardRequest: Promise<GateDashboardData> | undefined;

export type GateDashboardData = Readonly<{
  sheetName: string;
  isFallbackSheet: boolean;
  confirmed: number;
  pending: number;
  total: number;
  cashInHand: number;
  digitalRevenue: number;
  changeOwed: number;
  owedRunnerRows: readonly number[];
  roster: AttendanceRosterEntry[];
}>;

function isConfirmed(status: string): boolean {
  return status
    .trim()
    .toLocaleLowerCase("en-US")
    .includes("confirmed");
}

function isCashPayment(method: string): boolean {
  return method
    .trim()
    .toLocaleLowerCase("en-US")
    .includes("cash");
}

export function emptyGateDashboard(
  sheetName = getActiveAttendanceSheetName(),
): GateDashboardData {
  return {
    sheetName,
    isFallbackSheet: false,
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
  const roster = await getAttendanceRoster(sheetName);
  const payments = await listGatePayments(sheetName);
  const confirmed = roster.reduce(
    (count, runner) => count + (isConfirmed(runner.status) ? 1 : 0),
    0,
  );
  const cashInHand = payments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? payment.amountReceivedEgp
        : 0),
    0,
  );
  const digitalRevenue = payments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? 0
        : payment.amountReceivedEgp),
    0,
  );
  const changeOwed = payments.reduce(
    (sum, payment) => sum + payment.changeOwedEgp,
    0,
  );
  const owedRunnerRows = [
    ...new Set(
      payments
        .filter((payment) => payment.changeOwedEgp > 0)
        .map((payment) => payment.runnerRow),
    ),
  ];

  return {
    sheetName,
    isFallbackSheet: isFallback,
    confirmed,
    pending: Math.max(0, roster.length - confirmed),
    total: roster.length,
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
