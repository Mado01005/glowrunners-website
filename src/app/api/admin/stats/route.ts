import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  emptyGateDashboard,
  getGateDashboardData,
  invalidateGateDashboardCache,
  isMissingAttendanceDataError,
  isRateLimitedSheetsError,
  type GateDashboardData,
} from "@/lib/gateDashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function responseBody(
  dashboard: GateDashboardData,
  warning?: string,
) {
  return {
    success: true,
    sheetName: dashboard.sheetName,
    isFallbackSheet: dashboard.isFallbackSheet,
    walk_in_count: dashboard.walkInCount,
    walkInCount: dashboard.walkInCount,
    confirmed: dashboard.confirmed,
    pending: dashboard.pending,
    total: dashboard.total,
    cash_in_hand: dashboard.cashInHand,
    digital_revenue: dashboard.digitalRevenue,
    change_owed: dashboard.changeOwed,
    confirmedCount: dashboard.confirmed,
    pendingCount: dashboard.pending,
    totalCount: dashboard.total,
    cashInHand: dashboard.cashInHand,
    digitalRevenue: dashboard.digitalRevenue,
    changeOwed: dashboard.changeOwed,
    owedRunnerRows: dashboard.owedRunnerRows,
    roster: dashboard.roster,
    eventSettings: dashboard.eventSettings,
    ...(warning ? { warning } : {}),
  };
}

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { success: false, error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  try {
    if (new URL(request.url).searchParams.get("force") === "1") {
      invalidateGateDashboardCache();
    }

    const dashboard = await getGateDashboardData();
    return NextResponse.json(responseBody(dashboard), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    const warning = isRateLimitedSheetsError(error)
      ? "Live data is temporarily rate-limited; retrying automatically."
      : isMissingAttendanceDataError(error)
        ? "Attendance sheet is not available yet."
        : "Live attendance data is temporarily unavailable.";

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Attendance data is unavailable; returning zeroed stats.",
        route: "/api/admin/stats",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return NextResponse.json(
      responseBody(emptyGateDashboard(), warning),
      { headers: NO_STORE_HEADERS },
    );
  }
}
