import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  recordAdminActivity,
  saveGateEventSettings,
} from "@/lib/adminOperations";
import { invalidateGateDashboardCache } from "@/lib/gateDashboard";
import { resolveActiveAttendanceSheetName } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function PATCH(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { success: false, error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return NextResponse.json(
      { success: false, error: "Event settings must be a JSON object." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const eventDate =
    typeof body.eventDate === "string" ? body.eventDate.trim() : "";
  const eventTime =
    typeof body.eventTime === "string" ? body.eventTime.trim() : "";
  const location =
    typeof body.location === "string" ? body.location.trim() : "";

  if (
    !title ||
    title.length > 120 ||
    !DATE_PATTERN.test(eventDate) ||
    !TIME_PATTERN.test(eventTime) ||
    !location ||
    location.length > 180
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "Enter a valid event title, date, time, and location.",
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const { sheetName } = await resolveActiveAttendanceSheetName();
    const settings = await saveGateEventSettings(
      { sheetName, title, eventDate, eventTime, location },
      session.admin,
    );
    invalidateGateDashboardCache();

    let activityWarning: string | undefined;

    try {
      await recordAdminActivity(
        session.admin,
        "GATE_EVENT_SETTINGS_UPDATED",
        `${session.admin.displayName} updated gate event settings: ${title} · ${eventTime} · ${location}`,
        `gate-event-settings:${settings.id}`,
      );
    } catch {
      activityWarning = "Settings saved, but the activity log needs a retry.";
    }

    return NextResponse.json(
      { success: true, settings, ...(activityWarning ? { activityWarning } : {}) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/event-settings",
        message: "Unable to update gate event settings.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to update event settings." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
