import { NextRequest, NextResponse } from "next/server";

import { xaiFetchJson } from "@/lib/xai";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  const apiKeyHeader = _req.headers.get("x-xai-api-key")?.trim() || undefined;

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
    return NextResponse.json(
      { error: upstream.data },
      { status: upstream.status },
    );
  }

  return NextResponse.json(upstream.data);
}
