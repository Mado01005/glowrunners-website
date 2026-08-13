import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import { invalidateGateDashboardCache } from "@/lib/gateDashboard";
import {
  deleteAttendanceRunner,
  resolveActiveAttendanceSheetName,
  updateAttendanceRunner,
} from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const STATUS_VALUES = new Set([
  "CONFIRMED",
  "CLEARED",
  "PAID",
  "PENDING",
  "DEPOSIT_PAID",
  "OWED",
  "FREE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forbidden() {
  return NextResponse.json(
    { success: false, error: "Forbidden." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

function safeMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : Number.NaN;
}

function storedStatus(value: string): string {
  if (["CONFIRMED", "CLEARED", "PAID"].includes(value)) {
    return "✅ CONFIRMED";
  }

  if (value === "DEPOSIT_PAID") {
    return "DEPOSIT PAID";
  }

  return value;
}

export async function PATCH(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbidden();
  }

  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return NextResponse.json(
      { success: false, error: "Runner changes must be a JSON object." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const rowIndex = Number(body.rowIndex);
  const expectedName =
    typeof body.expectedName === "string" ? body.expectedName.trim() : "";
  const expectedPhone =
    typeof body.expectedPhone === "string" ? body.expectedPhone.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const paymentType =
    typeof body.paymentType === "string"
      ? body.paymentType.trim().slice(0, 40)
      : "Unknown";
  const requestedStatus =
    typeof body.status === "string" ? body.status.trim().toUpperCase() : "";
  const amountPaid = safeMoney(body.amountPaid);
  const balanceOwed = safeMoney(body.balanceOwed);

  if (
    !Number.isSafeInteger(rowIndex) ||
    rowIndex < 2 ||
    !expectedName ||
    !name ||
    name.length > 100 ||
    phone.length > 80 ||
    !STATUS_VALUES.has(requestedStatus) ||
    !Number.isFinite(amountPaid) ||
    !Number.isFinite(balanceOwed) ||
    amountPaid > 1_000_000 ||
    balanceOwed > 1_000_000
  ) {
    return NextResponse.json(
      { success: false, error: "Enter valid runner and payment details." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const isFree = requestedStatus === "FREE";

  try {
    const { sheetName } = await resolveActiveAttendanceSheetName();
    const runner = await updateAttendanceRunner(
      sheetName,
      rowIndex,
      expectedName,
      expectedPhone,
      {
        name,
        phone,
        paymentType,
        status: storedStatus(requestedStatus),
        amountPaid: isFree ? 0 : amountPaid,
        balanceOwed: isFree ? 0 : balanceOwed,
      },
    );
    invalidateGateDashboardCache();

    try {
      await recordAdminActivity(
        session.admin,
        "RUNNER_UPDATED",
        `${session.admin.displayName} updated runner: ${runner.name}`,
        `runner-update:${sheetName}:${rowIndex}:${Date.now()}`,
      );
    } catch {
      // The roster mutation remains authoritative if activity logging fails.
    }

    return NextResponse.json(
      { success: true, runner },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update runner.";
    const conflict = message.includes("Refresh the roster");
    return NextResponse.json(
      { success: false, error: message },
      { status: conflict ? 409 : 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbidden();
  }

  const body: unknown = await request.json().catch(() => null);
  const rowIndex = isRecord(body) ? Number(body.rowIndex) : Number.NaN;
  const expectedName =
    isRecord(body) && typeof body.expectedName === "string"
      ? body.expectedName.trim()
      : "";
  const expectedPhone =
    isRecord(body) && typeof body.expectedPhone === "string"
      ? body.expectedPhone.trim()
      : "";

  if (!Number.isSafeInteger(rowIndex) || rowIndex < 2 || !expectedName) {
    return NextResponse.json(
      { success: false, error: "Valid runner identity is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const { sheetName } = await resolveActiveAttendanceSheetName();
    await deleteAttendanceRunner(
      sheetName,
      rowIndex,
      expectedName,
      expectedPhone,
    );
    invalidateGateDashboardCache();

    try {
      await recordAdminActivity(
        session.admin,
        "RUNNER_DELETED",
        `${session.admin.displayName} permanently removed runner: ${expectedName}`,
        `runner-delete:${sheetName}:${rowIndex}:${Date.now()}`,
      );
    } catch {
      // The roster mutation remains authoritative if activity logging fails.
    }

    return NextResponse.json(
      { success: true, deletedRowIndex: rowIndex },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete runner.";
    const conflict = message.includes("Refresh the roster");
    return NextResponse.json(
      { success: false, error: message },
      { status: conflict ? 409 : 500, headers: NO_STORE_HEADERS },
    );
  }
}
