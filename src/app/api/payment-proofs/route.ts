import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { listEventParticipants } from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function isAllowedPrivateBlobUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".private.blob.vercel-storage.com") &&
      url.pathname.startsWith("/post-run-proofs/")
    );
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { success: false, error: "Forbidden." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const sourceUrl = new URL(request.url).searchParams.get("url") ?? "";
  const eventId = new URL(request.url).searchParams.get("eventId") ?? "";
  const participantId =
    new URL(request.url).searchParams.get("participantId") ?? "";

  if (
    !isAllowedPrivateBlobUrl(sourceUrl) ||
    !SAFE_ID_PATTERN.test(eventId) ||
    !SAFE_ID_PATTERN.test(participantId)
  ) {
    return NextResponse.json(
      { success: false, error: "Invalid payment proof URL." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const participants = await listEventParticipants(eventId, {
      includeArchived: session.admin.role === "super-admin",
    });
    const participant = participants.find(
      (candidate) => candidate.id === participantId,
    );

    if (participant?.paymentScreenshotUrl !== sourceUrl) {
      return NextResponse.json(
        { success: false, error: "Payment proof not found." },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    const result = await get(sourceUrl, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    });

    if (!result) {
      return NextResponse.json(
        { success: false, error: "Payment proof not found." },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    if (result.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: result.blob.etag,
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    return new Response(result.stream, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "Content-Type": result.blob.contentType,
        ETag: result.blob.etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/payment-proofs",
        message: "Private payment proof delivery failed.",
        admin: session.admin.id,
        eventId,
        participantId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return NextResponse.json(
      { success: false, error: "Payment proof could not be loaded." },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
