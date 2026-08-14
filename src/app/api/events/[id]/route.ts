import { del } from "@vercel/blob";
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
  deletePostRunEvent,
  unarchivePostRunEvent,
  updatePostRunEvent,
  type PostRunEventPatch,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
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

  const lifecycleValue = hasOwn(body, "isArchived")
    ? body.isArchived
    : hasOwn(body, "is_archived")
      ? body.is_archived
      : undefined;

  if (lifecycleValue !== undefined) {
    if (typeof lifecycleValue !== "boolean") {
      return NextResponse.json(
        { success: false, error: "isArchived must be true or false." },
        { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
      );
    }

    if (
      Object.keys(body).some(
        (key) => !["isArchived", "is_archived"].includes(key),
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Archive changes cannot be combined with event edits.",
        },
        { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
      );
    }

    try {
      const event = lifecycleValue
        ? await archivePostRunEvent(id, session.admin.phoneE164)
        : await unarchivePostRunEvent(id, session.admin.phoneE164);
      const action = lifecycleValue
        ? "POST_RUN_EVENT_ARCHIVED"
        : "POST_RUN_EVENT_UNARCHIVED";
      const verb = lifecycleValue ? "archived" : "unarchived";
      await recordAdminActivity(
        session.admin,
        action,
        `${session.admin.displayName} ${verb} post-run event: ${event.title}`,
        `post-run-event-${verb}:${event.id}:${event.updatedAt}`,
      );

      return NextResponse.json(
        { success: true, event: toEventResponse(event) },
        { headers: POST_RUN_NO_STORE_HEADERS },
      );
    } catch (error) {
      return postRunErrorResponse(error, `/api/events/${id}`);
    }
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
    const result = await deletePostRunEvent(id, session.admin.phoneE164);
    await recordAdminActivity(
      session.admin,
      "POST_RUN_EVENT_DELETED",
      `${session.admin.displayName} permanently deleted post-run event: ${result.event.title} (${result.participantCount} participant records removed)`,
      `post-run-event-delete:${result.event.id}:${Date.now()}`,
    );

    if (result.paymentProofUrls.length > 0) {
      const proofDeletionResults = await Promise.allSettled(
        result.paymentProofUrls.map((url) => del(url)),
      );
      const failedProofDeletions = proofDeletionResults.filter(
        (proofResult) => proofResult.status === "rejected",
      ).length;

      if (failedProofDeletions > 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            route: `/api/events/${id}`,
            message:
              "Some payment proof blobs could not be removed after event deletion.",
            eventId: result.event.id,
            failedProofDeletions,
          }),
        );
      }
    }

    return NextResponse.json(
      {
        success: true,
        event: toEventResponse(result.event),
        deletedParticipants: result.participantCount,
      },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, `/api/events/${id}`);
  }
}
