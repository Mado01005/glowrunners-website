import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  createEventExpense,
  listEventExpenses,
  recordAdminActivity,
} from "@/lib/adminOperations";

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
    const expenses = await listEventExpenses();
    return NextResponse.json(
      {
        success: true,
        expenses,
        totalEgp: expenses.reduce(
          (sum, expense) => sum + expense.amountEgp,
          0,
        ),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/expenses",
        message: "Unable to load expenses.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to load event expenses." },
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
  const description =
    typeof record?.description === "string"
      ? record.description.trim().slice(0, 240)
      : "";
  const amountEgp = Number(record?.amountEgp);
  const paymentMethod =
    typeof record?.paymentMethod === "string"
      ? record.paymentMethod.trim().slice(0, 40)
      : "Cash";
  const operationId =
    typeof record?.operationId === "string" &&
    /^[A-Za-z0-9:_-]{8,140}$/.test(record.operationId.trim())
      ? record.operationId.trim()
      : undefined;

  if (
    !description ||
    !Number.isFinite(amountEgp) ||
    amountEgp <= 0 ||
    amountEgp > 1_000_000
  ) {
    return NextResponse.json(
      { success: false, error: "Enter a valid expense and amount." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const expense = await createEventExpense(
      description,
      amountEgp,
      paymentMethod,
      session.admin,
      operationId,
    );
    await recordAdminActivity(
      session.admin,
      "EXPENSE_LOGGED",
      `${session.admin.displayName} logged expense: ${description} - ${amountEgp} EGP`,
      `expense:${expense.id}`,
    );
    return NextResponse.json(
      { success: true, expense },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/admin/expenses",
        message: "Unable to record expense.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { success: false, error: "Unable to record the event expense." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
