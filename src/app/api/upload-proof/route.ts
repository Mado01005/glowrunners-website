import { del, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";
import { recordAdminActivity } from "@/lib/adminOperations";
import { GoogleSheetsMutationOutcomeUnknownError } from "@/lib/googleSheets";
import {
  postRunErrorResponse,
  toParticipantResponse,
} from "@/lib/postRunApi";
import {
  listEventParticipants,
  updateEventParticipant,
} from "@/lib/postRunEvents";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_BYTES = 32_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;


function forbiddenResponse() {
  return NextResponse.json(
    { success: false, error: "Forbidden." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

function isSupportedImage(bytes: Uint8Array, contentType: string) {
  const isJpeg =
    contentType === "image/jpeg" &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isPng =
    contentType === "image/png" &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isWebp =
    contentType === "image/webp" &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;

  return isJpeg || isPng || isWebp;
}

function hasBlobStorage() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
      (process.env.VERCEL_OIDC_TOKEN?.trim() &&
        process.env.BLOB_STORE_ID?.trim()),
  );
}

export async function POST(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (!session) {
    return forbiddenResponse();
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  const eventId = formData?.get("eventId");
  const participantId = formData?.get("participantId");

  if (
    !(file instanceof File) ||
    typeof eventId !== "string" ||
    typeof participantId !== "string" ||
    !SAFE_ID_PATTERN.test(eventId) ||
    !SAFE_ID_PATTERN.test(participantId)
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "A valid image, event, and participant are required.",
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: "Payment proof must be between 1 byte and 5 MB.",
      },
      { status: 413, headers: NO_STORE_HEADERS },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (!isSupportedImage(bytes, file.type)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only valid JPEG, PNG, or WebP screenshots are accepted.",
      },
      { status: 415, headers: NO_STORE_HEADERS },
    );
  }

  let newlyStoredBlobUrl = "";

  try {
    const participants = await listEventParticipants(eventId);
    const currentParticipant = participants.find(
      (participant) => participant.id === participantId,
    );

    if (!currentParticipant) {
      return NextResponse.json(
        {
          success: false,
          error: "The participant was not found for this event.",
        },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    let storedProofUrl: string;
    let storage: "vercel-blob" | "inline-fallback";

    if (hasBlobStorage()) {
      const extension =
        file.type === "image/png"
          ? "png"
          : file.type === "image/webp"
            ? "webp"
            : "jpg";
      const blob = await put(
        `post-run-proofs/${eventId}/${participantId}-${crypto.randomUUID()}.${extension}`,
        Buffer.from(bytes),
        {
          access: "private",
          addRandomSuffix: true,
          contentType: file.type,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          cacheControlMaxAge: 60 * 5,
        },
      );
      newlyStoredBlobUrl = blob.url;
      storedProofUrl = blob.url;
      storage = "vercel-blob";
    } else {
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Proof storage is not configured and this fallback image is too large. Crop the screenshot and retry.",
          },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }

      storedProofUrl = `data:${file.type};base64,${Buffer.from(bytes).toString(
        "base64",
      )}`;
      storage = "inline-fallback";
    }

    const updatedParticipant = await updateEventParticipant(
      eventId,
      participantId,
      { paymentScreenshotUrl: storedProofUrl },
      session.admin.phoneE164,
    );
    await recordAdminActivity(
      session.admin,
      "PAYMENT_PROOF_UPLOADED",
      `${session.admin.displayName} uploaded payment proof for ${updatedParticipant.name}`,
      `proof-upload:${participantId}:${updatedParticipant.updatedAt}`,
    );

    if (
      currentParticipant.paymentScreenshotUrl &&
      currentParticipant.paymentScreenshotUrl !== storedProofUrl &&
      currentParticipant.paymentScreenshotUrl.includes(
        ".blob.vercel-storage.com",
      )
    ) {
      await del(currentParticipant.paymentScreenshotUrl).catch((error) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            route: "/api/upload-proof",
            message: "Old payment proof could not be removed.",
            eventId,
            participantId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }

    const responseParticipant = toParticipantResponse(updatedParticipant);

    return NextResponse.json(
      {
        success: true,
        url: responseParticipant.paymentProofUrl,
        storage,
        participant: responseParticipant,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (
      newlyStoredBlobUrl &&
      !(error instanceof GoogleSheetsMutationOutcomeUnknownError)
    ) {
      await del(newlyStoredBlobUrl).catch(() => undefined);
    }

    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/upload-proof",
        message: "Payment proof upload failed.",
        admin: session.admin.id,
        eventId,
        participantId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return postRunErrorResponse(error, "/api/upload-proof");
  }
}
