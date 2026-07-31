import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  postRunErrorResponse,
  toEventResponse,
  toFiniteNumber,
} from "@/lib/postRunApi";
import {
  createPostRunEvent,
  listPostRunEvents,
  type PostRunEventInput,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  try {
    const events = await listPostRunEvents();

    return NextResponse.json(
      { success: true, events: events.map(toEventResponse) },
      { headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, "/api/events");
  }
}

export async function POST(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const body: unknown = await request.json().catch(() => null);

  if (!isApiObject(body)) {
    return NextResponse.json(
      { success: false, error: "Event details must be a JSON object." },
      { status: 400, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const capacityValue = body.capacity ?? body.max_capacity;
  const input: PostRunEventInput = {
    title: typeof body.title === "string" ? body.title : "",
    associatedDate:
      typeof (body.runDate ?? body.run_date) === "string"
        ? String(body.runDate ?? body.run_date)
        : "",
    totalCostPerPersonEgp: toFiniteNumber(
      body.totalCost ?? body.total_cost,
    ),
    requiredDepositPerPersonEgp: toFiniteNumber(
      body.depositAmount ?? body.deposit_amount,
    ),
    maxCapacity:
      capacityValue === null ||
      capacityValue === undefined ||
      capacityValue === ""
        ? null
        : toFiniteNumber(capacityValue),
    paymentInstructions:
      typeof (body.paymentInstructions ?? body.payment_instructions) ===
      "string"
        ? String(body.paymentInstructions ?? body.payment_instructions)
        : "",
  };

  try {
    const event = await createPostRunEvent(
      input,
      session.admin.phoneE164,
    );

    return NextResponse.json(
      { success: true, event: toEventResponse(event) },
      { status: 201, headers: POST_RUN_NO_STORE_HEADERS },
    );
  } catch (error) {
    return postRunErrorResponse(error, "/api/events");
  }
}
