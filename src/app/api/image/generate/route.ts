import { NextResponse } from "next/server";
import { z } from "zod";

import { xaiFetchJson } from "@/lib/xai";
import { saveJob } from "@/lib/storage";
import crypto from "node:crypto";

export const runtime = "nodejs";

function createId() {
  return crypto.randomUUID();
}

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

  const id = createId();
  const data = upstream.data as any;
  const images: string[] = [];
  if (data && Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.url) images.push(item.url);
      else if (item.b64_json) images.push(`data:image/png;base64,${item.b64_json}`);
    }
  }

  await saveJob("image", id, {
    id,
    mode: "generate",
    prompt: parsed.data.prompt,
    createdAt: Date.now(),
    status: images.length > 0 ? "ready" : "error",
    inputs: {
      aspect_ratio: parsed.data.aspect_ratio,
      response_format: parsed.data.response_format,
    },
    images,
    error: images.length === 0 ? "No images returned" : undefined,
    raw: data,
  });

  return NextResponse.json(upstream.data);
}
