import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toEventResponse,
  toFiniteNumber,
} from "@/lib/postRunApi";
import {
  archivePostRunEvent,
  updatePostRunEvent,
  type PostRunEventPatch,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EventRouteContext = {
  params: Promise<{ id: string }>;
};

function hasOwn(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function superAdminRequiredResponse() {
  return NextResponse.json(
    {
      success: false,
      error: "Super Admin access is required for event settings.",
    },
    { status: 403, headers: POST_RUN_NO_STORE_HEADERS },
  );
}

export async function PATCH(
  request: Request,
  { params }: EventRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  if (session.admin.role !== "super-admin") {
    return superAdminRequiredResponse();
  }

  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);

  if (!isApiObject(body)) {
    return NextResponse.json(
      { success: false, error: "Event changes must be a JSON object." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const patch: {
    title?: string;
    associatedDate?: string;
    totalCostPerPersonEgp?: number;
    requiredDepositPerPersonEgp?: number;
    maxCapacity?: number | null;
    paymentInstructions?: string;
  } = {};

  if (hasOwn(body, "title")) {
    patch.title = typeof body.title === "string" ? body.title : "";
  }

  if (hasOwn(body, "runDate") || hasOwn(body, "run_date")) {
    patch.associatedDate = String(body.runDate ?? body.run_date ?? "");
  }

  if (
    hasOwn(body, "totalCost") ||
    hasOwn(body, "total_cost") ||
    hasOwn(body, "eventTicketPrice") ||
    hasOwn(body, "event_ticket_price")
  ) {
    patch.totalCostPerPersonEgp = toFiniteNumber(
      body.totalCost ??
        body.total_cost ??
        body.eventTicketPrice ??
        body.event_ticket_price,
    );
  }

  if (
    hasOwn(body, "depositAmount") ||
    hasOwn(body, "deposit_amount") ||
    hasOwn(body, "standardDeposit") ||
    hasOwn(body, "standard_deposit")
  ) {
    patch.requiredDepositPerPersonEgp = toFiniteNumber(
      body.depositAmount ??
        body.deposit_amount ??
        body.standardDeposit ??
        body.standard_deposit,
    );
  }

  if (hasOwn(body, "capacity") || hasOwn(body, "max_capacity")) {
    const value = body.capacity ?? body.max_capacity;
    patch.maxCapacity =
      value === null || value === undefined || value === ""
        ? null
        : toFiniteNumber(value);
  }

  if (
    hasOwn(body, "paymentInstructions") ||
    hasOwn(body, "payment_instructions")
  ) {
    patch.paymentInstructions = String(
      body.paymentInstructions ?? body.payment_instructions ?? "",
    );
  }

  try {
    const event = await updatePostRunEvent(
      id,
      patch as PostRunEventPatch,
      session.admin.phoneE164,
    );
    await recordAdminActivity(
      session.admin,
      "POST_RUN_EVENT_UPDATED",
      `${session.admin.displayName} updated event settings: ${event.title}`,
      `post-run-event-update:${event.id}:${event.updatedAt}`,
    );

    return NextResponse.json(
      { success: true, event: toEventResponse(event) },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, `/api/events/${id}`);
  }
}

export async function DELETE(
  request: Request,
  { params }: EventRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  if (session.admin.role !== "super-admin") {
    return superAdminRequiredResponse();
  }

  const { id } = await params;

  try {
    const event = await archivePostRunEvent(id, session.admin.phoneE164);
    await recordAdminActivity(
      session.admin,
      "POST_RUN_EVENT_ARCHIVED",
      `${session.admin.displayName} archived post-run event: ${event.title}`,
      `post-run-event-archive:${event.id}:${event.archivedAt}`,
    );

    return NextResponse.json(
      { success: true, event: toEventResponse(event) },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, `/api/events/${id}`);
  }
}
