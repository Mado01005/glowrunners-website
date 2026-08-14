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
    return await handleListPostRunEvents(request);
  } catch (error) {
    return postRunErrorResponse(error, "/api/events");
  }
}

export async function POST(request: Request) {
  try {
    return await handleCreatePostRunEvent(request, "/api/events");
  } catch (error) {
    return postRunErrorResponse(error, "/api/events");
  }
}
