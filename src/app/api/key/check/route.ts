import { NextResponse } from "next/server";
import { z } from "zod";

import { xaiFetchJson } from "@/lib/xai";

export const runtime = "nodejs";

const CheckSchema = z.object({
  api_key: z.string().min(1, "api_key is required"),
});

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) return [];

  const ids: string[] = [];
  for (const item of record.data) {
    if (item && typeof item === "object") {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CheckSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const upstream = await xaiFetchJson(
      "/v1/models",
      { method: "GET" },
      { apiKey: parsed.data.api_key.trim() },
    );

    if (!upstream.ok) {
      return NextResponse.json(
        { ok: false, error: upstream.data },
        { status: upstream.status },
      );
    }

    const modelIds = extractModelIds(upstream.data);
    return NextResponse.json({
      ok: true,
      models: modelIds,
      has_grok_imagine_video: modelIds.includes("grok-imagine-video"),
      has_grok_imagine_image: modelIds.includes("grok-imagine-image"),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 },
    );
  }
}
