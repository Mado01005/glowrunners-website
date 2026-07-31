import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  findRunnerByPhone,
  getActiveAttendanceSheetName,
  getAttendanceRoster,
  getConfirmedAttendanceCount,
  markAsConfirmed,
  resolveActiveAttendanceSheetName,
} from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PHONE_PATTERN = /^\d{7,15}$/;
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
    const { sheetName, isFallback } =
      await resolveActiveAttendanceSheetName();
    const roster = await getAttendanceRoster(sheetName);
    const confirmedCount = roster.reduce((count, runner) => {
      return runner.status
        .trim()
        .toLocaleLowerCase("en-US")
        .includes("confirmed")
        ? count + 1
        : count;
    }, 0);
    const totalCount = roster.length;

    return NextResponse.json(
      {
        success: true,
        sheetName,
        confirmedCount,
        pendingCount: Math.max(0, totalCount - confirmedCount),
        totalCount,
        roster,
        isFallbackSheet: isFallback,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
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
  const phone =
    isJsonObject(body) && typeof body.phone === "string"
      ? body.phone.trim()
      : "";

  if (!PHONE_PATTERN.test(phone)) {
    return NextResponse.json(
      {
        success: false,
        error: "Phone must contain between 7 and 15 numeric digits.",
        sheetName: expectedSheetName,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const { sheetName, isFallback } =
      await resolveActiveAttendanceSheetName();
    const runner = await findRunnerByPhone(sheetName, phone);

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

    const confirmedCount = await getConfirmedAttendanceCount(sheetName);

    return NextResponse.json(
      {
        success: true,
        name: runner.fullName,
        rowIndex: runner.rowIndex,
        sheetName,
        confirmedCount,
        isFallbackSheet: isFallback,
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
