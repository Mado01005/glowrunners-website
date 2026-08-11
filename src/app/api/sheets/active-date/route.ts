import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { resolveLatestAttendanceDate } from "@/lib/googleSheets";
import {
  forbiddenPostRunResponse,
  POST_RUN_NO_STORE_HEADERS,
} from "@/lib/postRunApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getAdminSessionFromRequest(request);

    if (!session) {
      return forbiddenPostRunResponse();
    }

    const activeDate = await resolveLatestAttendanceDate();

    return NextResponse.json(
      {
        success: true,
        date: activeDate?.date ?? null,
        sheetName: activeDate?.sheetName ?? null,
      },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/sheets/active-date",
        message: "Unable to resolve the latest Attendance tab date.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return NextResponse.json(
      {
        success: false,
        error: "The active run date is temporarily unavailable.",
      },
      { status: 503, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }
}
