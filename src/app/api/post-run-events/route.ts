import {
  handleCreatePostRunEvent,
  handleListPostRunEvents,
} from "@/lib/postRunEventHandlers";
import { postRunErrorResponse } from "@/lib/postRunApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";


export async function GET(request: Request) {
  try {
    return await handleListPostRunEvents(request, { bareEvents: true });
  } catch (error) {
    return postRunErrorResponse(error, "/api/post-run-events");
  }
}

export async function POST(request: Request) {
  try {
    return await handleCreatePostRunEvent(request, "/api/post-run-events");
  } catch (error) {
    return postRunErrorResponse(error, "/api/post-run-events");
  }
}
