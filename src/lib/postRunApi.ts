import { NextResponse } from "next/server";
import { GoogleSheetsMutationOutcomeUnknownError } from "@/lib/googleSheets";
import {
  normalizeContactInput,
  PostRunEventsError,
  type PostRunEvent,
  type PostRunParticipant,
  type PostRunParticipantPatch,
} from "@/lib/postRunEvents";

export const POST_RUN_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export function isApiObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return Number(value.replaceAll(",", "").trim());
  }

  return Number.NaN;
}

function hasOwn(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function toParticipantPatch(
  body: Record<string, unknown>,
): PostRunParticipantPatch {
  const patch: {
    name?: string;
    whatsappPhone?: string;
    depositStatus?: PostRunParticipantPatch["depositStatus"];
    depositAmountPaidEgp?: number;
    paymentMethod?: string;
    changeOwed?: number;
    paymentScreenshotUrl?: string | null;
    settlementStatus?: PostRunParticipantPatch["settlementStatus"];
    internalNotes?: string;
  } = {};


  if (hasOwn(body, "fullName") || hasOwn(body, "full_name")) {
    const value = body.fullName ?? body.full_name;
    patch.name = typeof value === "string" ? value : "";
  }

  if (
    hasOwn(body, "phoneNumber") ||
    hasOwn(body, "phone_number") ||
    hasOwn(body, "whatsappPhone") ||
    hasOwn(body, "whatsapp_phone") ||
    hasOwn(body, "whatsapp") ||
    hasOwn(body, "username")
  ) {
    const value =
      body.phoneNumber ??
      body.phone_number ??
      body.whatsappPhone ??
      body.whatsapp_phone ??
      body.whatsapp ??
      body.username ??
      "";
    patch.whatsappPhone = normalizeContactInput(
      typeof value === "string" ? value : "",
    );
  }

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

  if (hasOwn(body, "paymentMethod") || hasOwn(body, "payment_method")) {
    const value = body.paymentMethod ?? body.payment_method;
    patch.paymentMethod = typeof value === "string" ? value.trim() : "Cash";
  }

  if (hasOwn(body, "changeOwed") || hasOwn(body, "change_owed")) {
    patch.changeOwed = Math.max(
      0,
      toFiniteNumber(body.changeOwed ?? body.change_owed) || 0,
    );
  }

  return patch;
}

export function toEventResponse(event: PostRunEvent) {
  return {
    id: event.id,
    title: event.title,
    runDate: event.associatedDate,
    totalCost: event.totalCostPerPersonEgp,
    eventTicketPrice: event.totalCostPerPersonEgp,
    depositAmount: event.requiredDepositPerPersonEgp,
    standardDeposit: event.requiredDepositPerPersonEgp,
    paymentInstructions: event.paymentInstructions,
    capacity: event.maxCapacity,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    createdByAdmin: event.createdByAdminPhone,
    isArchived: event.archivedAt !== null,
    archivedAt: event.archivedAt,
    archivedByAdmin: event.archivedByAdminPhone,
  };
}

export function toParticipantResponse(participant: PostRunParticipant) {
  const storedProof = participant.paymentScreenshotUrl ?? "";
  const paymentProofUrl =
    storedProof && !storedProof.startsWith("data:")
      ? `/api/payment-proofs?eventId=${encodeURIComponent(
          participant.eventId,
        )}&participantId=${encodeURIComponent(
          participant.id,
        )}&url=${encodeURIComponent(storedProof)}`
      : storedProof;

  return {
    id: participant.id,
    eventId: participant.eventId,
    fullName: participant.name,
    phoneNumber: participant.whatsappPhone,
    depositStatus:
      participant.depositStatus === "Verified" ? "VERIFIED" : "PENDING",
    depositPaid: participant.depositAmountPaidEgp,
    amountPaid: participant.depositAmountPaidEgp,
    paymentProofUrl,
    paymentMethod: participant.paymentMethod || "Cash",
    changeOwed: participant.changeOwed || 0,
    remainingBalance: participant.remainingBalanceEgp,
    paymentStatus:
      participant.settlementStatus === "Free"
        ? "FREE"
        : participant.settlementStatus === "Fully Cleared"
          ? "FULLY_CLEARED"
          : participant.depositAmountPaidEgp > 0
            ? "DEPOSIT_PAID"
            : "UNPAID",
    settlementStatus:
      participant.settlementStatus === "Fully Cleared"
        ? "FULLY_CLEARED"
        : "UNPAID",
    checkedIn:
      participant.checkedIn === true ||
      participant.settlementStatus === "Free" ||
      participant.settlementStatus === "Fully Cleared",
    createdAt: participant.createdAt,
    updatedAt: participant.updatedAt,
    createdByAdmin: participant.createdByAdminPhone,
    updatedByAdmin: participant.updatedByAdminPhone,
    internalNotes: participant.internalNotes,
  };
}



export function forbiddenPostRunResponse() {
  return NextResponse.json(
    { success: false, error: "Forbidden." },
    { status: 403, headers: POST_RUN_NO_STORE_HEADERS },
  );
}

export function postRunErrorResponse(error: unknown, route: string) {
  if (error instanceof GoogleSheetsMutationOutcomeUnknownError) {
    console.error(
      JSON.stringify({
        level: "error",
        route,
        message: "Post-run mutation outcome could not be verified.",
        operation: error.operation,
      }),
    );

    return NextResponse.json(
      {
        success: false,
        error:
          "The change may already be saved. Refresh the ledger before retrying.",
        code: "MUTATION_OUTCOME_UNKNOWN",
      },
      { status: 503, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  if (error instanceof PostRunEventsError) {
    if (error.code === "CONFIGURATION") {
      console.warn(
        JSON.stringify({
          level: "warn",
          route,
          message: "Post-run event storage operational fallback.",
          error: error.message,
        }),
      );
      return NextResponse.json(
        { success: true, events: [], participants: [] },
        { status: 200, headers: POST_RUN_NO_STORE_HEADERS },
      );
    }

    const status =
      error.code === "VALIDATION"
        ? 400
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONFLICT" ||
              error.code === "CAPACITY_REACHED"
            ? 409
            : 503;

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        code: error.code,
      },
      { status, headers: POST_RUN_NO_STORE_HEADERS },
    );
  }

  console.error(
    JSON.stringify({
      level: "error",
      route,
      message: "Unexpected post-run events failure.",
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return NextResponse.json(
    {
      success: false,
      error: "The post-run events service is temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503, headers: POST_RUN_NO_STORE_HEADERS },
  );
}
