import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  recordAdminActivity,
  recordGatePayment,
} from "@/lib/adminOperations";
import {
  emptyGateDashboard,
  getGateDashboardData,
  invalidateGateDashboardCache,
  isMissingAttendanceDataError,
} from "@/lib/gateDashboard";
import {
  findRunnerByPhone,
  getActiveAttendanceSheetName,
  getConfirmedAttendanceCount,
  markAsConfirmed,
  normalizeEgyptianMobilePhone,
  resolveActiveAttendanceSheetName,
} from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logGoogleSheetsFailure(
  operation: "load-dashboard" | "check-in",
  error: unknown,
) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Google Sheets request failed.",
      operation,
      route: "/api/scan-ticket",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function forbiddenResponse() {
  return NextResponse.json(
    {
      success: false,
      error: "Forbidden.",
    },
    {
      status: 403,
      headers: NO_STORE_HEADERS,
    },
  );
}

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenResponse();
  }

  const expectedSheetName = getActiveAttendanceSheetName();

  try {
    const dashboard = await getGateDashboardData();

    return NextResponse.json(
      {
        success: true,
        sheetName: dashboard.sheetName,
        confirmedCount: dashboard.confirmed,
        pendingCount: dashboard.pending,
        totalCount: dashboard.total,
        cashInHand: dashboard.cashInHand,
        digitalRevenue: dashboard.digitalRevenue,
        changeOwed: dashboard.changeOwed,
        roster: dashboard.roster,
        isFallbackSheet: dashboard.isFallbackSheet,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (isMissingAttendanceDataError(error)) {
      const dashboard = emptyGateDashboard(expectedSheetName);

      return NextResponse.json(
        {
          success: true,
          sheetName: dashboard.sheetName,
          confirmedCount: 0,
          pendingCount: 0,
          totalCount: 0,
          cashInHand: 0,
          digitalRevenue: 0,
          changeOwed: 0,
          roster: [],
          isFallbackSheet: false,
          warning: "Attendance sheet is not available yet.",
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    logGoogleSheetsFailure("load-dashboard", error);

    return NextResponse.json(
      {
        success: false,
        error:
          "Unable to connect to Google Sheets. Check the server configuration.",
        sheetName: expectedSheetName,
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenResponse();
  }

  const expectedSheetName = getActiveAttendanceSheetName();
  const body: unknown = await request.json().catch(() => null);
  const rawPhone =
    isJsonObject(body) && typeof body.phone === "string"
      ? body.phone.trim()
      : "";
  const phone = normalizeEgyptianMobilePhone(rawPhone);

  if (!phone) {
    return NextResponse.json(
      {
        success: false,
        error: "Enter a valid Egyptian mobile phone number.",
        sheetName: expectedSheetName,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const operationId =
    isJsonObject(body) &&
    typeof body.operationId === "string" &&
    /^[A-Za-z0-9:_-]{8,140}$/.test(body.operationId.trim())
      ? body.operationId.trim()
      : randomUUID();
  const preferredRowIndex =
    isJsonObject(body) &&
    Number.isSafeInteger(Number(body.runnerRow)) &&
    Number(body.runnerRow) > 0
      ? Number(body.runnerRow)
      : undefined;
  const requestedPaymentMethod =
    isJsonObject(body) && typeof body.paymentMethod === "string"
      ? body.paymentMethod.trim().slice(0, 40)
      : "";
  const amountDue =
    isJsonObject(body) && body.amountDue !== undefined
      ? Number(body.amountDue)
      : 0;
  const amountReceived =
    isJsonObject(body) && body.amountReceived !== undefined
      ? Number(body.amountReceived)
      : 0;
  const changeOwed =
    isJsonObject(body) && body.changeOwed !== undefined
      ? Number(body.changeOwed)
      : Math.max(0, amountReceived - amountDue);

  if (
    ![amountDue, amountReceived, changeOwed].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000,
    )
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "Payment amounts must be valid non-negative EGP values.",
        sheetName: expectedSheetName,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const { sheetName, isFallback } =
      await resolveActiveAttendanceSheetName();
    const runner = await findRunnerByPhone(
      sheetName,
      phone,
      preferredRowIndex,
    );

    if (!runner) {
      return NextResponse.json(
        {
          success: false,
          error: "No runner was found for this ticket.",
          sheetName,
          isFallbackSheet: isFallback,
        },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    await markAsConfirmed(sheetName, runner.rowIndex);

    if (amountDue > 0 || amountReceived > 0) {
      await recordGatePayment(
        {
          id: operationId,
          sheetName,
          runnerRow: runner.rowIndex,
          runnerName: runner.fullName,
          runnerPhone: runner.phone,
          paymentMethod:
            requestedPaymentMethod || runner.paymentType || "Unknown",
          amountDueEgp: amountDue,
          amountReceivedEgp: amountReceived,
          changeOwedEgp: changeOwed,
        },
        session.admin,
      );
    }

    await recordAdminActivity(
      session.admin,
      "RUNNER_CHECKED_IN",
      `${session.admin.displayName} checked in Runner: ${runner.fullName}`,
      `checkin:${operationId}`,
    );
    invalidateGateDashboardCache();

    const confirmedCount = await getConfirmedAttendanceCount(sheetName);

    return NextResponse.json(
      {
        success: true,
        name: runner.fullName,
        rowIndex: runner.rowIndex,
        sheetName,
        confirmedCount,
        isFallbackSheet: isFallback,
        operationId,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    logGoogleSheetsFailure("check-in", error);

    return NextResponse.json(
      {
        success: false,
        error:
          "Unable to connect to Google Sheets. Check the server configuration.",
        sheetName: expectedSheetName,
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
