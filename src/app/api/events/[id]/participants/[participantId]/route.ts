import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import { invalidateGateDashboardCache } from "@/lib/gateDashboard";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toParticipantPatch,
  toParticipantResponse,
} from "@/lib/postRunApi";
import {
  deleteEventParticipant,
  updateEventParticipant,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";


type ParticipantRouteContext = {
  params: Promise<{ id: string; participantId: string }>;
};

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

  const patch = toParticipantPatch(body);

  try {
    const participant = await updateEventParticipant(
      id,
      participantId,
      patch,
      session.admin.phoneE164,
    );
    invalidateGateDashboardCache();
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
    invalidateGateDashboardCache();
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
