import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
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

import { recordAdminActivity } from "@/lib/adminOperations";
import { randomUUID } from "node:crypto";


export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;



export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { success: false, error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
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
    return NextResponse.json(
      { success: false, error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const expectedSheetName = getActiveAttendanceSheetName();
  const body: unknown = await request.json().catch(() => null);

  const rawPhone =
    typeof body === "object" && body !== null && "phone" in body
      ? String((body as Record<string, unknown>).phone).trim()
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
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).operationId === "string"
      ? String((body as Record<string, unknown>).operationId).trim()
      : randomUUID();

  const preferredRowIndex =
    typeof body === "object" &&
    body !== null &&
    Number.isSafeInteger(Number((body as Record<string, unknown>).runnerRow))
      ? Number((body as Record<string, unknown>).runnerRow)
      : undefined;

  try {
    const { sheetName, isFallback } = await resolveActiveAttendanceSheetName();
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

    // Explicitly write "TRUE" to Column F and confirm
    await markAsConfirmed(sheetName, runner.rowIndex);
    invalidateGateDashboardCache();

    await recordAdminActivity(
      session.admin,
      "RUNNER_CHECKED_IN",
      `${session.admin.displayName} checked in Runner: ${runner.fullName}`,
      `checkin:${operationId}`,
    );

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
        checkedIn: true,
        status: "CONFIRMED",
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to complete check-in.",
        sheetName: expectedSheetName,
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
