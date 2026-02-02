import { NextResponse } from "next/server";
import { z } from "zod";

import { xaiFetchJson } from "@/lib/xai";

export const runtime = "nodejs";

const UrlAssetSchema = z.object({
  url: z.string().url(),
});

const StartVideoSchema = z
  .object({
    mode: z.enum(["generate", "edit"]).default("generate"),
    prompt: z.string().min(1, "Prompt is required"),
    model: z.string().min(1).default("grok-imagine-video"),
    image: UrlAssetSchema.optional(),
    video: UrlAssetSchema.optional(),
    image_url: z.string().url().optional(),
    video_url: z.string().url().optional(),
    duration: z.number().int().min(1).max(15).optional(),
    aspect_ratio: z
      .enum(["16:9", "4:3", "1:1", "9:16", "3:4", "3:2", "2:3"])
      .optional(),
    resolution: z.enum(["720p", "480p"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "edit" && !value.video_url && !value.video?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "video.url (or video_url) is required for edit mode",
        path: ["video"],
      });
    }
  });

export async function POST(req: Request) {
  const apiKeyHeader = req.headers.get("x-xai-api-key")?.trim() || undefined;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = StartVideoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { mode, image, video, image_url, video_url, ...rest } = parsed.data;
  const endpoint =
    mode === "edit" ? "/v1/videos/edits" : "/v1/videos/generations";

  const payload: Record<string, unknown> = { ...rest };
  if (mode === "edit") {
    delete payload.duration;

    const url = video?.url ?? video_url;
    if (url) {
      payload.video_url = url;
      payload.video = { url };
    }
  }

  if (mode === "generate") {
    const url = image?.url ?? image_url;
    if (url) {
      payload.image_url = url;
      payload.image = { url };
    }
  }

  let upstream: Awaited<ReturnType<typeof xaiFetchJson>>;
  try {
    upstream = await xaiFetchJson(
      endpoint,
      {
        method: "POST",
        body: JSON.stringify(payload),
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
    return NextResponse.json(
      { error: upstream.data },
      { status: upstream.status },
    );
  }

  const requestId =
    typeof upstream.data === "object" &&
    upstream.data !== null &&
    "request_id" in upstream.data
      ? (upstream.data as { request_id: unknown }).request_id
      : undefined;

  if (typeof requestId !== "string" || requestId.length === 0) {
    return NextResponse.json(
      { error: "xAI response missing request_id", upstream: upstream.data },
      { status: 502 },
    );
  }

  return NextResponse.json({ request_id: requestId });
}
