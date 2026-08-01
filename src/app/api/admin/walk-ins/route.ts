import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  recordAdminActivity,
  recordGateWalkIn,
} from "@/lib/adminOperations";
import { invalidateGateDashboardCache } from "@/lib/gateDashboard";
import {
  normalizeEgyptianMobilePhone,
  resolveActiveAttendanceSheetName,
} from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WALK_IN_FEE_EGP = 70;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forbiddenResponse() {
  return NextResponse.json(
    { success: false, error: "Forbidden." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenResponse();
  }

  const body: unknown = await request.json().catch(() => null);
  const name = isRecord(body) && typeof body.name === "string"
    ? body.name.trim().slice(0, 100)
    : "";
  const rawPhone = isRecord(body) && typeof body.phone === "string"
    ? body.phone.trim()
    : "";
  const phone = rawPhone ? normalizeEgyptianMobilePhone(rawPhone) : "";
  const paymentMethod =
    isRecord(body) && body.paymentMethod === "InstaPay"
      ? "InstaPay"
      : "Cash";
  const amountReceived =
    isRecord(body) && body.amountReceived !== undefined
      ? Number(body.amountReceived)
      : WALK_IN_FEE_EGP;
  const operationId =
    isRecord(body) &&
    typeof body.operationId === "string" &&
    /^[A-Za-z0-9:_-]{8,140}$/.test(body.operationId.trim())
      ? body.operationId.trim()
      : randomUUID();

  if (!name) {
    return NextResponse.json(
      { success: false, error: "Enter the walk-in runner’s full name." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (rawPhone && !phone) {
    return NextResponse.json(
      {
        success: false,
        error: "Enter a valid Egyptian mobile number or leave it blank.",
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (
    !Number.isSafeInteger(amountReceived) ||
    amountReceived < WALK_IN_FEE_EGP ||
    amountReceived > 1_000_000
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `Amount received must be a whole number of at least ${WALK_IN_FEE_EGP} EGP.`,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const changeOwed = amountReceived - WALK_IN_FEE_EGP;

  try {
    const { sheetName } = await resolveActiveAttendanceSheetName();
    const walkIn = await recordGateWalkIn(
      {
        id: operationId,
        sheetName,
        name,
        phone: phone || "",
        paymentMethod,
        amountPaidEgp: amountReceived,
        changeOwedEgp: changeOwed,
      },
      session.admin,
    );

    let activityWarning: string | undefined;

    try {
      await recordAdminActivity(
        session.admin,
        "WALK_IN_ADDED",
        `${session.admin.displayName} added Walk-In: ${name} (Paid ${amountReceived} EGP, Owed ${changeOwed} EGP Change)`,
        `walk-in:${operationId}`,
      );
    } catch (error) {
      activityWarning = "Walk-in saved, but the activity log needs a retry.";
      console.error(
        JSON.stringify({
          level: "error",
          route: "/api/admin/walk-ins",
          message: "Walk-in saved but activity logging failed.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    invalidateGateDashboardCache();

    return NextResponse.json(
      {
        success: true,
        walkIn: {
          ...walkIn,
          amountReceived: walkIn.amountPaidEgp,
          changeOwed: walkIn.changeOwedEgp,
        },
        ...(activityWarning ? { warning: activityWarning } : {}),
      },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/walk-ins",
        message: "Unable to record walk-in runner.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return NextResponse.json(
      { success: false, error: "Unable to record the walk-in runner." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
