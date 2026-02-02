import { NextResponse } from "next/server";
import { z } from "zod";

import { xaiFetchJson } from "@/lib/xai";

export const runtime = "nodejs";

const UrlAssetSchema = z.object({
  url: z.string().min(1),
});

const ImageUrlAssetSchema = z.object({
  image_url: z.string().min(1),
});

const EditImageSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  model: z.string().min(1).default("grok-imagine-image"),
  image: z.union([UrlAssetSchema, ImageUrlAssetSchema, z.string().min(1)]).optional(),
  image_url: z.string().min(1).optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
});

function normalizeImageUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  const compact = trimmed.replace(/\s+/g, "");
  const looksLikeBase64 = /^[a-z0-9+/=]+$/i.test(compact) && compact.length > 200;
  if (looksLikeBase64) {
    return `data:image/png;base64,${compact}`;
  }

  return trimmed;
}

export async function POST(req: Request) {
  const apiKeyHeader = req.headers.get("x-xai-api-key")?.trim() || undefined;
  if (!apiKeyHeader) {
    return NextResponse.json(
      { error: "Missing xAI API key (x-xai-api-key)." },
      { status: 401 },
    );
  }
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid multipart form body" },
        { status: 400 },
      );
    }

    const prompt = String(form.get("prompt") ?? "").trim();
    const model = String(form.get("model") ?? "grok-imagine-image").trim();
    const responseFormatRaw = form.get("response_format");
    const response_format =
      responseFormatRaw === "url" || responseFormatRaw === "b64_json"
        ? String(responseFormatRaw)
        : undefined;

    const image = form.get("image");
    const file =
      typeof File !== "undefined" && image instanceof File ? image : null;

    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    if (!file || file.size === 0) {
      return NextResponse.json({ error: "image file is required" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const base64 = bytes.toString("base64");

    const mime = file.type?.trim() || "image/png";
    const dataUrl = `data:${mime};base64,${base64}`;

    const payload: Record<string, unknown> = {
      model: model || "grok-imagine-image",
      prompt,
      image_url: dataUrl,
      image: { url: dataUrl },
    };
    if (response_format) payload.response_format = response_format;

    let upstream: Awaited<ReturnType<typeof xaiFetchJson>>;
    try {
      upstream = await xaiFetchJson(
        "/v1/images/edits",
        { method: "POST", body: JSON.stringify(payload) },
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

    return NextResponse.json(upstream.data);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = EditImageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { image, image_url, ...rest } = parsed.data;
  const imageValue =
    typeof image === "string"
      ? image
      : image && "url" in image
        ? image.url
        : image && "image_url" in image
          ? image.image_url
          : image_url;

  if (!imageValue) {
    return NextResponse.json(
      { error: "image.image_url (or image.url / image_url) is required" },
      { status: 400 },
    );
  }

  const normalizedImageUrl = normalizeImageUrl(imageValue);

  const payload: Record<string, unknown> = {
    ...rest,
    image_url: normalizedImageUrl,
    image: { url: normalizedImageUrl },
  };

  let upstream: Awaited<ReturnType<typeof xaiFetchJson>>;
  try {
    upstream = await xaiFetchJson(
      "/v1/images/edits",
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
    return NextResponse.json({ error: upstream.data }, { status: upstream.status });
  }

  return NextResponse.json(upstream.data);
}
