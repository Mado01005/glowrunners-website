import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toParticipantResponse,
  toFiniteNumber,
} from "@/lib/postRunApi";
import {
  addEventParticipant,
  listEventParticipants,
  type PostRunParticipantInput,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ParticipantsRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: Request,
  { params }: ParticipantsRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const { id } = await params;

  try {
    const participants = await listEventParticipants(id);

    return NextResponse.json(
      {
        success: true,
        participants: participants.map(toParticipantResponse),
      },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(
      error,
      `/api/events/${id}/participants`,
    );
  }
}

export async function POST(
  request: Request,
  { params }: ParticipantsRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);

  if (!isApiObject(body)) {
    return NextResponse.json(
      { success: false, error: "Participant details must be a JSON object." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const input: PostRunParticipantInput = {
    name:
      typeof (body.fullName ?? body.full_name) === "string"
        ? String(body.fullName ?? body.full_name)
        : "",
    whatsappPhone:
      typeof (body.phoneNumber ?? body.phone_number) === "string"
        ? String(body.phoneNumber ?? body.phone_number)
        : "",
    depositStatus:
      body.depositStatus === "VERIFIED" ||
      body.deposit_status === "VERIFIED"
        ? "Verified"
        : "Pending",
    depositAmountPaidEgp:
      body.depositPaid === undefined && body.deposit_paid === undefined
        ? 0
        : toFiniteNumber(body.depositPaid ?? body.deposit_paid),
    paymentScreenshotUrl:
      typeof (body.paymentProofUrl ?? body.payment_proof_url) === "string"
        ? String(body.paymentProofUrl ?? body.payment_proof_url)
        : null,
    settlementStatus:
      body.settlementStatus === "FULLY_CLEARED" ||
      body.settlement_status === "FULLY_CLEARED"
        ? "Fully Cleared"
        : "Unpaid",
  };

  try {
    const participant = await addEventParticipant(
      id,
      input,
      session.admin.phoneE164,
    );
    await recordAdminActivity(
      session.admin,
      "POST_RUN_PARTICIPANT_ADDED",
      `${session.admin.displayName} added ${participant.name} to a post-run event`,
      `post-run-participant:${participant.id}`,
    );

    return NextResponse.json(
      { success: true, participant: toParticipantResponse(participant) },
      { status: 201, headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(
      error,
      `/api/events/${id}/participants`,
    );
  }
}
