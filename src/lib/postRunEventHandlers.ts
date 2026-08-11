import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import { resolveLatestAttendanceDate } from "@/lib/googleSheets";
import {
  forbiddenPostRunResponse,
  isApiObject,
  POST_RUN_NO_STORE_HEADERS,
  toEventResponse,
  toFiniteNumber,
} from "@/lib/postRunApi";
import {
  createPostRunEvent,
  listPostRunEvents,
  type PostRunEventInput,
} from "@/lib/postRunEvents";

export async function handleListPostRunEvents(
  request: Request,
  options: Readonly<{ bareEvents?: boolean }> = {},
) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenPostRunResponse();
  }

  const includeArchived =
    new URL(request.url).searchParams.get("includeArchived") === "true";

  if (includeArchived && session.admin.role !== "super-admin") {
    return NextResponse.json(
      {
        success: false,
        error: "Super Admin access is required to view archived events.",
      },
      { status: 403, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  const events = (await listPostRunEvents({ includeArchived })).map(
    toEventResponse,
  );

  return NextResponse.json(
    options.bareEvents ? events : { success: true, events },
    { headers: POST_RUN_NO_STORE_HEADERS },
  );
}

export async function handleCreatePostRunEvent(
  request: Request,
  route: string,
) {
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

  const requestedRunDate = body.runDate ?? body.run_date;
  let associatedDate =
    typeof requestedRunDate === "string" ? requestedRunDate : "";

  if (session.admin.role !== "super-admin") {
    const activeDate = await resolveLatestAttendanceDate();

    if (!activeDate) {
      return NextResponse.json(
        {
          success: false,
          error:
            "No dated Attendance tab is available. Ask a Super Admin to select the run date.",
        },
        { status: 503, headers: POST_RUN_NO_STORE_HEADERS },
      );
    }

    associatedDate = activeDate.date;
  }

  const capacityValue = body.capacity ?? body.max_capacity;
  const input: PostRunEventInput = {
    title: typeof body.title === "string" ? body.title : "",
    associatedDate,
    totalCostPerPersonEgp: toFiniteNumber(
      body.totalCost ??
        body.total_cost ??
        body.eventTicketPrice ??
        body.event_ticket_price,
    ),
    requiredDepositPerPersonEgp: toFiniteNumber(
      body.depositAmount ??
        body.deposit_amount ??
        body.standardDeposit ??
        body.standard_deposit,
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
  const event = await createPostRunEvent(input, session.admin.phoneE164);

  try {
    await recordAdminActivity(
      session.admin,
      "POST_RUN_EVENT_CREATED",
      `${session.admin.displayName} created post-run event: ${event.title}`,
      `post-run-event:${event.id}`,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route,
        message: "Event was created but its admin activity log failed.",
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return NextResponse.json(
    { success: true, event: toEventResponse(event) },
    { status: 201, headers: POST_RUN_NO_STORE_HEADERS },
  );
}
