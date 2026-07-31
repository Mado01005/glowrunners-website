import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  acquireRunnerLock,
  listActiveRunnerLocks,
  releaseRunnerLock,
} from "@/lib/adminOperations";
import { isRateLimitedSheetsError } from "@/lib/gateDashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

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

  try {
    const locks = await listActiveRunnerLocks();
    return NextResponse.json(
      { success: true, locks },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (isRateLimitedSheetsError(error)) {
      return NextResponse.json(
        {
          success: true,
          locks: [],
          warning:
            "Runner lock status is temporarily rate-limited. Acquisitions remain protected.",
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/runner-locks",
        message: "Unable to load runner locks.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to load runner processing state." },
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
  const action =
    typeof record?.action === "string"
      ? record.action.trim().toLowerCase()
      : "";

  try {
    if (action === "release") {
      const lockId =
        typeof record?.lockId === "string" ? record.lockId.trim() : "";

      if (!lockId) {
        return NextResponse.json(
          { success: false, error: "A lock ID is required." },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }

      await releaseRunnerLock(lockId, session.admin);
      return NextResponse.json(
        { success: true },
        { headers: NO_STORE_HEADERS },
      );
    }

    if (action !== "acquire") {
      return NextResponse.json(
        { success: false, error: "Use acquire or release." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const sheetName =
      typeof record?.sheetName === "string" ? record.sheetName.trim() : "";
    const runnerRow = Number(record?.runnerRow);
    const runnerName =
      typeof record?.runnerName === "string" ? record.runnerName.trim() : "";
    const runnerPhone =
      typeof record?.runnerPhone === "string"
        ? record.runnerPhone.trim()
        : "";

    if (
      !sheetName ||
      !Number.isSafeInteger(runnerRow) ||
      runnerRow < 1 ||
      !runnerName ||
      !runnerPhone
    ) {
      return NextResponse.json(
        { success: false, error: "Valid runner details are required." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const result = await acquireRunnerLock(
      { sheetName, runnerRow, runnerName, runnerPhone },
      session.admin,
    );

    return NextResponse.json(
      { success: true, ...result },
      {
        status: result.acquired ? 201 : 409,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/runner-locks",
        message: "Unable to update runner lock.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to update runner processing state." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
