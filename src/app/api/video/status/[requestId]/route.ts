import { NextRequest, NextResponse } from "next/server";

import { xaiFetchJson } from "@/lib/xai";
import { updateJob } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  const apiKeyHeader = _req.headers.get("x-xai-api-key")?.trim() || undefined;
  if (!apiKeyHeader) {
    return NextResponse.json(
      { error: "Missing xAI API key (x-xai-api-key)." },
      { status: 401 },
    );
  }

  let upstream: Awaited<ReturnType<typeof xaiFetchJson>>;
  try {
    upstream = await xaiFetchJson(
      `/v1/videos/${encodeURIComponent(requestId)}`,
      {
        method: "GET",
      },
      { apiKey: apiKeyHeader },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "xAI request failed" },
      { status: 500 },
    );
  }

  if (upstream.status === 202) {
    return NextResponse.json({ status: "processing" }, { status: 202 });
  }

  if (!upstream.ok) {
    await updateJob("video", requestId, {
      status: "error",
      error: upstream.data,
    });
    return NextResponse.json(
      { error: upstream.data },
      { status: upstream.status },
    );
  }

  // Check if it has a video URL or failure state in the data
  const data = upstream.data as any;
  if (data && typeof data === "object") {
    const state = data.status || data.state || data.phase || data.stage;
    const isError = ["failed", "error", "errored", "canceled", "cancelled"].includes(String(state).toLowerCase());
    
    if (isError) {
      await updateJob("video", requestId, {
        status: "error",
        error: data.error || data.message || `Request ${state}`,
        raw: data
      });
    } else {
      // Look for video URL
      const hasUrl = data.url || data.video_url || data.output_url;
      if (hasUrl) {
        await updateJob("video", requestId, {
          status: "ready",
          videoUrl: hasUrl,
          raw: data
        });
      }
    }
  }

  return NextResponse.json(upstream.data);
}
