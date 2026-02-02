import { NextResponse } from "next/server";
import { z } from "zod";

import { xaiFetchJson } from "@/lib/xai";

export const runtime = "nodejs";

const GenerateImageSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  model: z.string().min(1).default("grok-imagine-image"),
  aspect_ratio: z
    .string()
    .regex(/^\d+:\d+$/, "aspect_ratio must look like 4:3")
    .optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
});

export async function POST(req: Request) {
  const apiKeyHeader = req.headers.get("x-xai-api-key")?.trim() || undefined;
  if (!apiKeyHeader) {
    return NextResponse.json(
      { error: "Missing xAI API key (x-xai-api-key)." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = GenerateImageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let upstream: Awaited<ReturnType<typeof xaiFetchJson>>;
  try {
    upstream = await xaiFetchJson(
      "/v1/images/generations",
      {
        method: "POST",
        body: JSON.stringify(parsed.data),
      },
      { apiKey: apiKeyHeader },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "xAI request failed" },
      { status: 500 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: upstream.data }, { status: upstream.status });
  }

  return NextResponse.json(upstream.data);
}
