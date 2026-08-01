import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  listAdminActivities,
  recordAdminActivity,
} from "@/lib/adminOperations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const ALLOWED_CLIENT_ACTIONS = new Set([
  "CLOSE_GATE_REPORT",
]);

function forbidden() {
  return NextResponse.json(
    { success: false, error: "Forbidden." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbidden();
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(250, Math.trunc(requestedLimit)))
    : 100;

  try {
    const activities = await listAdminActivities(limit);
    return NextResponse.json(
      { success: true, activities },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/activity",
        message: "Unable to load activity log.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to load the activity log." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbidden();
  }

  const body: unknown = await request.json().catch(() => null);
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const actionType =
    typeof record?.actionType === "string"
      ? record.actionType.trim().toUpperCase()
      : "";
  const description =
    typeof record?.description === "string"
      ? record.description.trim().slice(0, 500)
      : "";
  const operationId =
    typeof record?.operationId === "string"
      ? record.operationId.trim().slice(0, 100)
      : undefined;

  if (!ALLOWED_CLIENT_ACTIONS.has(actionType) || !description) {
    return NextResponse.json(
      { success: false, error: "Invalid activity log request." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const activity = await recordAdminActivity(
      session.admin,
      actionType,
      description,
      operationId,
    );
    return NextResponse.json(
      { success: true, activity },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/activity",
        message: "Unable to record activity.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to record the activity." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
