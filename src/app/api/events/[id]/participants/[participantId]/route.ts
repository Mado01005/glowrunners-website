import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toFiniteNumber,
  toParticipantResponse,
} from "@/lib/postRunApi";
import {
  deleteEventParticipant,
  updateEventParticipant,
  type PostRunParticipantPatch,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ParticipantRouteContext = {
  params: Promise<{ id: string; participantId: string }>;
};

function hasOwn(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export async function PATCH(
  request: Request,
  { params }: ParticipantRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const { id, participantId } = await params;
  const body: unknown = await request.json().catch(() => null);

  if (!isApiObject(body)) {
    return NextResponse.json(
      { success: false, error: "Participant changes must be a JSON object." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const patch: {
    depositStatus?: PostRunParticipantPatch["depositStatus"];
    depositAmountPaidEgp?: number;
    paymentScreenshotUrl?: string | null;
    settlementStatus?: PostRunParticipantPatch["settlementStatus"];
    internalNotes?: string;
  } = {};

  if (hasOwn(body, "depositStatus") || hasOwn(body, "deposit_status")) {
    const value = body.depositStatus ?? body.deposit_status;
    patch.depositStatus =
      value === "VERIFIED"
        ? "Verified"
        : value === "PENDING"
          ? "Pending"
          : (value as PostRunParticipantPatch["depositStatus"]);
  }

  if (
    hasOwn(body, "amountPaid") ||
    hasOwn(body, "amount_paid") ||
    hasOwn(body, "depositPaid") ||
    hasOwn(body, "deposit_paid")
  ) {
    patch.depositAmountPaidEgp = toFiniteNumber(
      body.amountPaid ??
        body.amount_paid ??
        body.depositPaid ??
        body.deposit_paid,
    );
  }

  if (
    hasOwn(body, "paymentProofUrl") ||
    hasOwn(body, "payment_proof_url")
  ) {
    const value = body.paymentProofUrl ?? body.payment_proof_url;
    patch.paymentScreenshotUrl =
      value === null || value === "" ? null : String(value);
  }

  if (hasOwn(body, "internalNotes") || hasOwn(body, "internal_notes")) {
    patch.internalNotes = String(
      body.internalNotes ?? body.internal_notes ?? "",
    );
  }

  if (
    hasOwn(body, "settlementStatus") ||
    hasOwn(body, "settlement_status") ||
    hasOwn(body, "paymentStatus") ||
    hasOwn(body, "payment_status")
  ) {
    const value =
      body.paymentStatus ??
      body.payment_status ??
      body.settlementStatus ??
      body.settlement_status;
    const normalizedValue =
      typeof value === "string" ? value.trim().toUpperCase() : value;
    patch.settlementStatus =
      normalizedValue === "FREE" || normalizedValue === "FREE ATTENDEE"
        ? "Free"
        : normalizedValue === "FULLY_CLEARED"
          ? "Fully Cleared"
          : normalizedValue === "UNPAID" ||
              normalizedValue === "DEPOSIT_PAID"
            ? "Unpaid"
            : (value as PostRunParticipantPatch["settlementStatus"]);

    if (patch.settlementStatus === "Free") {
      patch.depositAmountPaidEgp = 0;
    }
  }

  try {
    const participant = await updateEventParticipant(
      id,
      participantId,
      patch,
      session.admin.phoneE164,
    );
    const action =
      participant.settlementStatus === "Fully Cleared" &&
      (patch.settlementStatus === "Fully Cleared" ||
        patch.depositAmountPaidEgp !== undefined)
        ? "POST_RUN_BALANCE_CLEARED"
        : "POST_RUN_PARTICIPANT_UPDATED";
    const description =
      action === "POST_RUN_BALANCE_CLEARED"
        ? `${session.admin.displayName} cleared the remaining balance for ${participant.name}`
        : `${session.admin.displayName} updated post-run payment details for ${participant.name}`;
    await recordAdminActivity(
      session.admin,
      action,
      description,
      `post-run-update:${participant.id}:${participant.updatedAt}`,
    );

    return NextResponse.json(
      { success: true, participant: toParticipantResponse(participant) },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(
      error,
      `/api/events/${id}/participants/${participantId}`,
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: ParticipantRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  if (session.admin.role !== "super-admin") {
    return NextResponse.json(
      {
        success: false,
        error: "Super Admin access is required to delete participants.",
      },
      { status: 403, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const { id, participantId } = await params;

  try {
    const participant = await deleteEventParticipant(
      id,
      participantId,
      session.admin.phoneE164,
    );
    await recordAdminActivity(
      session.admin,
      "POST_RUN_PARTICIPANT_DELETED",
      `${session.admin.displayName} deleted ${participant.name} from a post-run event`,
      `post-run-participant-delete:${participant.id}:${participant.deletedAt}`,
    );

    return NextResponse.json(
      { success: true, participant: toParticipantResponse(participant) },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(
      error,
      `/api/events/${id}/participants/${participantId}`,
    );
  }
}
