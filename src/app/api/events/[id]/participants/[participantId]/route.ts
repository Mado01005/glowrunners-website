import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toFiniteNumber,
  toParticipantResponse,
} from "@/lib/postRunApi";
import {
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

  if (hasOwn(body, "depositPaid") || hasOwn(body, "deposit_paid")) {
    patch.depositAmountPaidEgp = toFiniteNumber(
      body.depositPaid ?? body.deposit_paid,
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

  if (
    hasOwn(body, "settlementStatus") ||
    hasOwn(body, "settlement_status")
  ) {
    const value = body.settlementStatus ?? body.settlement_status;
    patch.settlementStatus =
      value === "FULLY_CLEARED"
        ? "Fully Cleared"
        : value === "UNPAID"
          ? "Unpaid"
          : (value as PostRunParticipantPatch["settlementStatus"]);
  }

  try {
    const participant = await updateEventParticipant(
      id,
      participantId,
      patch,
      session.admin.phoneE164,
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
