import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import { invalidateGateDashboardCache } from "@/lib/gateDashboard";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toParticipantResponse,
} from "@/lib/postRunApi";
import { updateEventParticipant } from "@/lib/postRunEvents";



export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";


type CheckinRouteContext = {

  params: Promise<{ id: string }>;
};

export async function POST(
  request: Request,
  { params }: CheckinRouteContext,
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);

  if (!isApiObject(body)) {
    return NextResponse.json(
      { success: false, error: "Check-in details must be a JSON object." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const participantId =
    typeof (body.participantId ?? body.participant_id ?? body.id) === "string"
      ? String(body.participantId ?? body.participant_id ?? body.id).trim()
      : "";

  if (!participantId) {
    return NextResponse.json(
      { success: false, error: "Participant ID is required for check-in." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  try {
    const participant = await updateEventParticipant(
      id,
      participantId,
      {
        settlementStatus: "Fully Cleared",
      },
      session.admin.phoneE164,
    );
    invalidateGateDashboardCache();

    await recordAdminActivity(
      session.admin,
      "POST_RUN_PARTICIPANT_CHECKED_IN",
      `${session.admin.displayName} checked in ${participant.name} to event`,
      `post-run-checkin:${participant.id}:${Date.now()}`,
    );

    return NextResponse.json(
      {
        success: true,
        checkedIn: true,
        status: "CONFIRMED",
        participant: toParticipantResponse(participant),
      },
      { status: 200, headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, `/api/events/${id}/checkin`);
  }
}
