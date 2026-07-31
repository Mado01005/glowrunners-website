import { NextResponse } from "next/server";
import { GoogleSheetsMutationOutcomeUnknownError } from "@/lib/googleSheets";
import {
  PostRunEventsError,
  type PostRunEvent,
  type PostRunParticipant,
} from "@/lib/postRunEvents";

export const POST_RUN_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
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
    remainingBalance: participant.remainingBalanceEgp,
    settlementStatus:
      participant.settlementStatus === "Fully Cleared"
        ? "FULLY_CLEARED"
        : "UNPAID",
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
    const status =
      error.code === "VALIDATION"
        ? 400
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONFLICT" ||
              error.code === "CAPACITY_REACHED"
            ? 409
            : 500;

    if (status >= 500) {
      console.error(
        JSON.stringify({
          level: "error",
          route,
          message: "Post-run event storage configuration failed.",
          error: error.message,
          code: error.code,
        }),
      );
    }

    return NextResponse.json(
      {
        success: false,
        error:
          status >= 500
            ? "Post-run event storage is not fully configured."
            : error.message,
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
    },
    { status: 502, headers: POST_RUN_NO_STORE_HEADERS },
  );
}
