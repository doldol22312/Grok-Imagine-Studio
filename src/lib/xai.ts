import { z } from "zod";

const XaiEnvSchema = z.object({
  XAI_API_KEY: z.string().min(1).optional(),
  XAI_BASE_URL: z.string().min(1).optional(),
});

export type XaiEnv = z.infer<typeof XaiEnvSchema>;

export function getXaiEnv(): XaiEnv {
  const parsed = XaiEnvSchema.safeParse({
    XAI_API_KEY: process.env.XAI_API_KEY,
    XAI_BASE_URL: process.env.XAI_BASE_URL,
  });

  if (!parsed.success) {
    throw new Error("Invalid xAI environment variables");
  }

  return parsed.data;
}

export function getXaiBaseUrl(env: XaiEnv): string {
  const trimmed = env.XAI_BASE_URL?.replace(/\/+$/, "");
  if (!trimmed) return "https://api.x.ai";

  // Allow users to paste "https://api.x.ai/v1" without breaking our "/v1/..." paths.
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);

  return trimmed;
}

export async function xaiFetchJson(
  path: string,
  init: RequestInit,
  opts?: { apiKey?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const env = getXaiEnv();
  const baseUrl = getXaiBaseUrl(env);
  const apiKey = opts?.apiKey ?? env.XAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing xAI API key. Set XAI_API_KEY or provide one.");
  }

  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Accept", "application/json");

  if (typeof init.body === "string" && init.body.length > 0 && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();

  if (!text) {
    return { ok: res.ok, status: res.status, data: null };
  }

  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}
