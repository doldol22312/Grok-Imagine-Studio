"use client";

import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCcw,
  Square,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MODEL = "grok-imagine-video";
const IMAGE_MODEL = "grok-imagine-image";
const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "9:16", "3:4", "3:2", "2:3"] as const;
const RESOLUTIONS = ["720p", "480p"] as const;

type Studio = "video" | "image";
type Mode = "generate" | "edit";
type JobStatus = "processing" | "ready" | "error" | "stopped";
type ResponseFormat = "url" | "b64_json";

type VideoJob = {
  requestId: string;
  mode: Mode;
  prompt: string;
  createdAt: number;
  status: JobStatus;
  keyId?: string;
  lastState?: string;
  lastPolledAt?: number;
  inputs: {
    duration?: number;
    aspect_ratio?: (typeof ASPECT_RATIOS)[number];
    resolution?: (typeof RESOLUTIONS)[number];
    image_url?: string;
    video_url?: string;
  };
  videoUrl?: string;
  raw?: unknown;
  error?: string;
};

const STORAGE_KEY = "grok-imagine-video:jobs:v1";
const IMAGE_STORAGE_KEY = "grok-imagine-image:jobs:v1";
const KEYS_STORAGE_KEY = "grok-imagine-video:keys:v1";
const ROTATION_STORAGE_KEY = "grok-imagine-video:keys:rr-index:v1";

type KeyHealth = "unknown" | "ok" | "invalid" | "rate_limited" | "error";

type ApiKeyEntry = {
  id: string;
  label: string;
  key: string;
  enabled: boolean;
  health: KeyHealth;
  lastCheckedAt?: number;
  lastError?: string;
  hasGrokImagineVideo?: boolean;
  hasGrokImagineImage?: boolean;
};

type ImageJob = {
  id: string;
  mode: Mode;
  prompt: string;
  createdAt: number;
  status: "ready" | "error";
  keyId?: string;
  inputs: {
    aspect_ratio?: (typeof ASPECT_RATIOS)[number];
    response_format?: ResponseFormat;
    image_source?: string;
  };
  images?: string[];
  raw?: unknown;
  error?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRelativeTime(epochMs: number) {
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stringifyError(value: unknown) {
  if (!value) return "Unknown error";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeState(value: string) {
  return value.trim().toLowerCase();
}

function extractState(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidates = [record.status, record.state, record.phase, record.stage];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  if (typeof record.message === "string" && record.message.trim())
    return record.message;

  if (record.error && typeof record.error === "object") {
    const errorRecord = record.error as Record<string, unknown>;
    if (typeof errorRecord.message === "string" && errorRecord.message.trim()) {
      return errorRecord.message;
    }
    if (typeof errorRecord.detail === "string" && errorRecord.detail.trim()) {
      return errorRecord.detail;
    }
  }

  return null;
}

function extractVideoUrl(payload: unknown): string | null {
  const candidates: Array<{ keyHint: string; url: string }> = [];
  const seen = new Set<unknown>();

  function maybeAddUrl(keyHint: string, value: unknown) {
    if (typeof value !== "string") return;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    candidates.push({ keyHint, url });
  }

  function walk(value: unknown, keyHint: string, depth: number) {
    if (depth > 5) return;
    if (!value) return;
    if (typeof value === "string") {
      maybeAddUrl(keyHint, value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    for (const [k, v] of entries) {
      const nextHint = k.toLowerCase().includes("url") ? k : keyHint;
      if (typeof v === "string") maybeAddUrl(nextHint, v);
      else walk(v, nextHint, depth + 1);
    }
  }

  // First: likely direct fields
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    maybeAddUrl("url", record.url);
    maybeAddUrl("video_url", record.video_url);
    maybeAddUrl("output_url", record.output_url);
    maybeAddUrl("download_url", record.download_url);
    maybeAddUrl("signed_url", record.signed_url);
  }

  // Then: deep scan
  walk(payload, "", 0);

  if (candidates.length === 0) return null;

  const preferredKeys = ["url", "video_url", "output_url", "download_url", "signed_url"];
  for (const key of preferredKeys) {
    const hit = candidates.find((c) => c.keyHint === key);
    if (hit) return hit.url;
  }

  const mp4 = candidates.find((c) => c.url.toLowerCase().includes(".mp4"));
  if (mp4) return mp4.url;

  return candidates[0]?.url ?? null;
}

function extractImageUrls(payload: unknown): string[] {
  const candidates: Array<{ keyHint: string; value: string }> = [];
  const seen = new Set<unknown>();

  function maybeAdd(keyHint: string, value: unknown) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;

    if (/^data:image\//i.test(trimmed)) {
      candidates.push({ keyHint, value: trimmed });
      return;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      candidates.push({ keyHint, value: trimmed });
      return;
    }

    const hint = keyHint.toLowerCase();
    if (hint.includes("b64") || hint.includes("base64")) {
      const cleaned = trimmed.replace(/^data:.*;base64,/, "");
      if (/^[a-z0-9+/=]+$/i.test(cleaned) && cleaned.length > 200) {
        candidates.push({ keyHint, value: `data:image/png;base64,${cleaned}` });
      }
    }
  }

  function walk(value: unknown, keyHint: string, depth: number) {
    if (depth > 6) return;
    if (!value) return;
    if (typeof value === "string") {
      maybeAdd(keyHint, value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      maybeAdd(k, v);
      walk(v, k, depth + 1);
    }
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    maybeAdd("url", record.url);
    if (Array.isArray(record.data)) {
      for (const item of record.data) {
        if (item && typeof item === "object") {
          const itemRecord = item as Record<string, unknown>;
          maybeAdd("url", itemRecord.url);
          maybeAdd("b64_json", itemRecord.b64_json);
        }
      }
    }
    if (Array.isArray(record.images)) {
      for (const item of record.images) {
        if (item && typeof item === "object") {
          const itemRecord = item as Record<string, unknown>;
          maybeAdd("url", itemRecord.url);
          maybeAdd("b64_json", itemRecord.b64_json);
        } else {
          maybeAdd("image", item);
        }
      }
    }
  }

  walk(payload, "", 0);

  const unique: string[] = [];
  const seenValues = new Set<string>();

  const scored = candidates
    .map((candidate) => {
      const value = candidate.value;
      const hint = candidate.keyHint.toLowerCase();
      let score = 0;

      if (value.startsWith("data:image/")) score += 3;
      if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(value)) score += 4;
      if (hint.includes("b64")) score += 2;
      if (hint.includes("image")) score += 1;
      if (hint === "url") score += 1;

      return { value, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const candidate of scored) {
    if (seenValues.has(candidate.value)) continue;
    seenValues.add(candidate.value);
    unique.push(candidate.value);
  }

  return unique;
}

const FAILURE_STATES = new Set([
  "failed",
  "error",
  "errored",
  "canceled",
  "cancelled",
]);

const SUCCESS_STATES = new Set([
  "succeeded",
  "success",
  "completed",
  "complete",
  "done",
  "ready",
]);

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

function maskKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 10) return "••••••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function VideoStudio() {
  const [studio, setStudio] = React.useState<Studio>("video");
  const [mode, setMode] = React.useState<Mode>("generate");
  const [imageMode, setImageMode] = React.useState<Mode>("generate");
  const [prompt, setPrompt] = React.useState("");
  const [imageUrl, setImageUrl] = React.useState("");
  const [imageDataUrl, setImageDataUrl] = React.useState("");
  const [imageFileName, setImageFileName] = React.useState("");
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [videoUrl, setVideoUrl] = React.useState("");
  const [imageResponseFormat, setImageResponseFormat] =
    React.useState<ResponseFormat>("url");
  const [duration, setDuration] = React.useState(6);
  const [aspectRatio, setAspectRatio] =
    React.useState<(typeof ASPECT_RATIOS)[number]>("16:9");
  const [resolution, setResolution] =
    React.useState<(typeof RESOLUTIONS)[number]>("720p");

  const [keys, setKeys] = React.useState<ApiKeyEntry[]>([]);
  const [rotationIndex, setRotationIndex] = React.useState(0);
  const [newKeyLabel, setNewKeyLabel] = React.useState("");
  const [newKeyValue, setNewKeyValue] = React.useState("");
  const [bulkKeys, setBulkKeys] = React.useState("");
  const [checkingKeys, setCheckingKeys] = React.useState(false);

  const [jobs, setJobs] = React.useState<VideoJob[]>([]);
  const [activeId, setActiveId] = React.useState<string>("");
  const [imageJobs, setImageJobs] = React.useState<ImageJob[]>([]);
  const [activeImageId, setActiveImageId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const [uiError, setUiError] = React.useState<string>("");

  const activeJob = React.useMemo(() => {
    if (!activeId) return jobs[0] ?? null;
    return jobs.find((j) => j.requestId === activeId) ?? jobs[0] ?? null;
  }, [activeId, jobs]);

  const activeImageJob = React.useMemo(() => {
    if (!activeImageId) return imageJobs[0] ?? null;
    return imageJobs.find((j) => j.id === activeImageId) ?? imageJobs[0] ?? null;
  }, [activeImageId, imageJobs]);

  const enabledKeys = React.useMemo(() => keys.filter((k) => k.enabled), [keys]);
  const nextKey =
    enabledKeys.length > 0
      ? enabledKeys[rotationIndex % enabledKeys.length] ?? null
      : null;

  const activeRequestId = activeJob?.requestId ?? "";
  const activeStatus = activeJob?.status ?? null;
  const activeKeyId = activeJob?.keyId ?? "";
  const activeKeyEntry = React.useMemo(() => {
    if (!activeJob?.keyId) return null;
    return keys.find((k) => k.id === activeJob.keyId) ?? null;
  }, [activeJob?.keyId, keys]);
  const activeApiKey = activeKeyEntry?.key?.trim() || undefined;

  const activeImageKeyEntry = React.useMemo(() => {
    if (!activeImageJob?.keyId) return null;
    return keys.find((k) => k.id === activeImageJob.keyId) ?? null;
  }, [activeImageJob?.keyId, keys]);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      setJobs(parsed as VideoJob[]);
      const firstProcessing = (parsed as VideoJob[]).find(
        (j) => j.status === "processing",
      );
      if (firstProcessing) setActiveId(firstProcessing.requestId);
    } catch {
      // ignore
    }

    try {
      const rawImages = localStorage.getItem(IMAGE_STORAGE_KEY);
      if (rawImages) {
        const parsedImages = JSON.parse(rawImages) as unknown;
        if (Array.isArray(parsedImages)) {
          const normalized: ImageJob[] = parsedImages
            .map((value) => {
              if (!value || typeof value !== "object") return null;
              const record = value as Record<string, unknown>;

              const id =
                typeof record.id === "string" && record.id.length > 0
                  ? record.id
                  : createId();

              const mode = record.mode === "edit" ? "edit" : "generate";

              const prompt = typeof record.prompt === "string" ? record.prompt : "";
              if (!prompt.trim()) return null;

              const createdAt =
                typeof record.createdAt === "number" ? record.createdAt : Date.now();

              const status = record.status === "error" ? "error" : "ready";

              const keyId =
                typeof record.keyId === "string" && record.keyId.length > 0
                  ? record.keyId
                  : undefined;

              const inputsRecord =
                record.inputs && typeof record.inputs === "object"
                  ? (record.inputs as Record<string, unknown>)
                  : {};

              const aspect_ratio =
                typeof inputsRecord.aspect_ratio === "string" &&
                (ASPECT_RATIOS as readonly string[]).includes(inputsRecord.aspect_ratio)
                  ? (inputsRecord.aspect_ratio as (typeof ASPECT_RATIOS)[number])
                  : undefined;

              const response_format =
                inputsRecord.response_format === "url" ||
                inputsRecord.response_format === "b64_json"
                  ? (inputsRecord.response_format as ResponseFormat)
                  : undefined;

              const image_source =
                typeof inputsRecord.image_source === "string"
                  ? inputsRecord.image_source
                  : undefined;

              const images = Array.isArray(record.images)
                ? (record.images as unknown[])
                    .map((v) => (typeof v === "string" ? v : null))
                    .filter((v): v is string => v !== null)
                    .slice(0, 6)
                : undefined;

              const error = typeof record.error === "string" ? record.error : undefined;

              const entry: ImageJob = {
                id,
                mode,
                prompt,
                createdAt,
                status,
                keyId,
                inputs: { aspect_ratio, response_format, image_source },
                images,
                error,
              };

              return entry;
            })
            .filter((value): value is ImageJob => value !== null);

          setImageJobs(normalized);
          if (normalized.length > 0) setActiveImageId(normalized[0].id);
        }
      }
    } catch {
      // ignore
    }

    try {
      const rawKeys = localStorage.getItem(KEYS_STORAGE_KEY);
      if (rawKeys) {
        const parsedKeys = JSON.parse(rawKeys) as unknown;
        if (Array.isArray(parsedKeys)) {
          const normalized: ApiKeyEntry[] = parsedKeys
            .map((value, index) => {
              if (!value || typeof value !== "object") return null;
              const record = value as Record<string, unknown>;
              const key = typeof record.key === "string" ? record.key : "";
              if (!key.trim()) return null;

              const id =
                typeof record.id === "string" && record.id.length > 0
                  ? record.id
                  : createId();

              const label =
                typeof record.label === "string" && record.label.trim().length > 0
                  ? record.label.trim()
                  : `Key ${index + 1}`;

              const enabled =
                typeof record.enabled === "boolean" ? record.enabled : true;

              const health =
                record.health === "ok" ||
                record.health === "invalid" ||
                record.health === "rate_limited" ||
                record.health === "error"
                  ? (record.health as KeyHealth)
                  : "unknown";

              const lastCheckedAt =
                typeof record.lastCheckedAt === "number"
                  ? record.lastCheckedAt
                  : undefined;

              const lastError =
                typeof record.lastError === "string" ? record.lastError : undefined;

              const hasGrokImagineVideo =
                typeof record.hasGrokImagineVideo === "boolean"
                  ? record.hasGrokImagineVideo
                  : undefined;

              const hasGrokImagineImage =
                typeof record.hasGrokImagineImage === "boolean"
                  ? record.hasGrokImagineImage
                  : undefined;

              const entry: ApiKeyEntry = {
                id,
                label,
                key,
                enabled,
                health,
                lastCheckedAt,
                lastError,
                hasGrokImagineVideo,
                hasGrokImagineImage,
              };

              return entry;
            })
            .filter((value): value is ApiKeyEntry => value !== null);

          setKeys(normalized);
        }
      }
    } catch {
      // ignore
    }

    try {
      const rawIndex = localStorage.getItem(ROTATION_STORAGE_KEY);
      if (rawIndex) {
        const parsedIndex = Number(rawIndex);
        if (Number.isFinite(parsedIndex) && parsedIndex >= 0) {
          setRotationIndex(parsedIndex);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    try {
      const serialized = jobs.slice(0, 25).map((job) => {
        const { raw, ...rest } = job;
        void raw;
        return rest;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // ignore
    }
  }, [jobs]);

  React.useEffect(() => {
    try {
      const serialized = imageJobs.slice(0, 25).map((job) => {
        const { raw, images, ...rest } = job;
        void raw;
        const safeImages =
          images?.filter((value) => /^https?:\/\//i.test(value)).slice(0, 6) ??
          undefined;
        return { ...rest, images: safeImages };
      });
      localStorage.setItem(IMAGE_STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // ignore
    }
  }, [imageJobs]);

  React.useEffect(() => {
    try {
      localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(keys.slice(0, 20)));
    } catch {
      // ignore
    }
  }, [keys]);

  React.useEffect(() => {
    try {
      localStorage.setItem(ROTATION_STORAGE_KEY, String(rotationIndex));
    } catch {
      // ignore
    }
  }, [rotationIndex]);

  React.useEffect(() => {
    setUiError("");
  }, [studio]);

  React.useEffect(() => {
    if (!activeRequestId || activeStatus !== "processing") return;
    if (!activeKeyId) {
      const msg = "Missing API key for this job. Re-add it in API keys (local).";
      setJobs((prev) =>
        prev.map((j) =>
          j.requestId === activeRequestId
            ? { ...j, status: "error", error: msg }
            : j,
        ),
      );
      setUiError(msg);
      return;
    }
    if (!activeApiKey) return;

    let cancelled = false;
    const requestId = activeRequestId;
    const apiKey = activeApiKey;

    async function poll() {
      while (!cancelled) {
        const res = await fetch(
          `/api/video/status/${encodeURIComponent(requestId)}`,
          {
            cache: "no-store",
            headers: { "x-xai-api-key": apiKey },
          },
        );

        if (res.status === 202) {
          await sleep(2000);
          continue;
        }

        const data = (await res.json().catch(() => null)) as unknown;
        const polledAt = Date.now();
        const state = extractState(data);
        const normalizedState = state ? normalizeState(state) : "";

        if (!res.ok) {
          const msg = stringifyError(data) || res.statusText;
          setJobs((prev) =>
            prev.map((j) =>
              j.requestId === requestId
                ? {
                    ...j,
                    status: "error",
                    error: msg,
                    raw: data,
                    lastState: state ?? j.lastState,
                    lastPolledAt: polledAt,
                  }
                : j,
            ),
          );
          setUiError(msg);
          return;
        }

        if (normalizedState && FAILURE_STATES.has(normalizedState)) {
          const msg = extractErrorMessage(data) ?? `Request ${state}`;
          setJobs((prev) =>
            prev.map((j) =>
              j.requestId === requestId
                ? {
                    ...j,
                    status: "error",
                    error: msg,
                    raw: data,
                    lastState: state ?? j.lastState,
                    lastPolledAt: polledAt,
                  }
                : j,
            ),
          );
          setUiError(msg);
          return;
        }

        const url = extractVideoUrl(data);
        if (url) {
          setJobs((prev) =>
            prev.map((j) =>
              j.requestId === requestId
                ? {
                    ...j,
                    status: "ready",
                    videoUrl: url,
                    raw: data,
                    lastState: state ?? j.lastState,
                    lastPolledAt: polledAt,
                  }
                : j,
            ),
          );
          return;
        }

        if (normalizedState && SUCCESS_STATES.has(normalizedState)) {
          const msg =
            extractErrorMessage(data) ?? `Request ${state}, but no URL returned`;
          setJobs((prev) =>
            prev.map((j) =>
              j.requestId === requestId
                ? {
                    ...j,
                    status: "error",
                    error: msg,
                    raw: data,
                    lastState: state ?? j.lastState,
                    lastPolledAt: polledAt,
                  }
                : j,
            ),
          );
          setUiError(msg);
          return;
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.requestId === requestId
              ? {
                  ...j,
                  raw: data,
                  lastState: state ?? j.lastState,
                  lastPolledAt: polledAt,
                }
              : j,
          ),
        );

        await sleep(2000);
      }
    }

    poll().catch((err) => {
      const msg = stringifyError(err);
      setJobs((prev) =>
        prev.map((j) =>
          j.requestId === requestId ? { ...j, status: "error", error: msg } : j,
        ),
      );
      setUiError(msg);
    });

    return () => {
      cancelled = true;
    };
  }, [activeApiKey, activeKeyId, activeRequestId, activeStatus]);

  const statusBadge = (() => {
    if (!activeJob) return <Badge>Ready</Badge>;
    if (activeJob.status === "ready") return <Badge variant="success">Ready</Badge>;
    if (activeJob.status === "processing")
      return <Badge variant="warning">Processing</Badge>;
    if (activeJob.status === "stopped") return <Badge>Stopped</Badge>;
    return <Badge variant="danger">Error</Badge>;
  })();

  const imageStatusBadge = (() => {
    if (!activeImageJob) return <Badge>Ready</Badge>;
    if (activeImageJob.status === "ready")
      return <Badge variant="success">Ready</Badge>;
    return <Badge variant="danger">Error</Badge>;
  })();

  React.useEffect(() => {
    if (enabledKeys.length === 0) {
      if (rotationIndex !== 0) setRotationIndex(0);
      return;
    }
    if (rotationIndex >= enabledKeys.length) {
      setRotationIndex(rotationIndex % enabledKeys.length);
    }
  }, [enabledKeys.length, rotationIndex]);

  function addKeysFromStrings(lines: Array<{ label?: string; key: string }>) {
    const candidates = lines
      .map((item) => ({ label: item.label?.trim() ?? "", key: item.key.trim() }))
      .filter((item) => item.key.length > 0);

    if (candidates.length === 0) return;

    setKeys((prev) => {
      const existing = new Set(prev.map((k) => k.key.trim()));
      const next = [...prev];

      for (const candidate of candidates) {
        if (existing.has(candidate.key)) continue;
        existing.add(candidate.key);

        next.unshift({
          id: createId(),
          label: candidate.label || maskKey(candidate.key),
          key: candidate.key,
          enabled: true,
          health: "unknown",
        });
      }

      return next.slice(0, 20);
    });
  }

  function addSingleKey() {
    const key = newKeyValue.trim();
    if (!key) return;

    const label = newKeyLabel.trim();
    addKeysFromStrings([{ label, key }]);
    setNewKeyValue("");
    setNewKeyLabel("");
  }

  function addBulkKeys() {
    const raw = bulkKeys.trim();
    if (!raw) return;

    const parsed = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const pipeIndex = line.indexOf("|");
        if (pipeIndex > -1) {
          return {
            label: line.slice(0, pipeIndex).trim(),
            key: line.slice(pipeIndex + 1).trim(),
          };
        }
        return { key: line };
      });

    addKeysFromStrings(parsed);
    setBulkKeys("");
  }

  function toggleKeyEnabled(id: string) {
    setKeys((prev) =>
      prev.map((k) => (k.id === id ? { ...k, enabled: !k.enabled } : k)),
    );
  }

  function removeKey(id: string) {
    setKeys((prev) => prev.filter((k) => k.id !== id));
  }

  function setKeyHealth(id: string, patch: Partial<ApiKeyEntry>) {
    setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  }

  async function checkKey(id: string) {
    const entry = keys.find((k) => k.id === id);
    if (!entry) return;

    setKeyHealth(id, { health: "unknown", lastError: undefined });

    try {
      const res = await fetch("/api/key/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: entry.key }),
      });

      const data = (await res.json().catch(() => null)) as unknown;

      if (!res.ok) {
        const msg = stringifyError(data) || res.statusText;
        setKeyHealth(id, {
          health:
            res.status === 401 || res.status === 403
              ? "invalid"
              : res.status === 429
                ? "rate_limited"
                : "error",
          lastCheckedAt: Date.now(),
          lastError: msg,
          hasGrokImagineVideo: undefined,
          hasGrokImagineImage: undefined,
        });
        return;
      }

      const hasGrokImagineVideo =
        data && typeof data === "object" && "has_grok_imagine_video" in data
          ? Boolean((data as { has_grok_imagine_video: unknown }).has_grok_imagine_video)
          : undefined;

      const hasGrokImagineImage =
        data && typeof data === "object" && "has_grok_imagine_image" in data
          ? Boolean((data as { has_grok_imagine_image: unknown }).has_grok_imagine_image)
          : undefined;

      setKeyHealth(id, {
        health: "ok",
        lastCheckedAt: Date.now(),
        lastError: undefined,
        hasGrokImagineVideo,
        hasGrokImagineImage,
      });
    } catch (err) {
      setKeyHealth(id, {
        health: "error",
        lastCheckedAt: Date.now(),
        lastError: stringifyError(err),
        hasGrokImagineVideo: undefined,
        hasGrokImagineImage: undefined,
      });
    }
  }

  async function checkAllKeys() {
    if (keys.length === 0) return;
    setCheckingKeys(true);
    try {
      for (const entry of keys) {
        await checkKey(entry.id);
        await sleep(150);
      }
    } finally {
      setCheckingKeys(false);
    }
  }

  async function onPickImage(file: File | null | undefined) {
    setUiError("");
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setUiError("Pick an image file.");
      return;
    }

    const maxBytes = 3 * 1024 * 1024;
    if (file.size > maxBytes) {
      setUiError("Image too large (max 3MB). Use an image URL instead.");
      return;
    }

    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onerror = () => reject(new Error("Failed to read image."));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });

    setImageDataUrl(dataUrl);
    setImageFileName(file.name);
    setImageFile(file);
    setImageUrl("");
  }

  function clearImageInput() {
    setImageUrl("");
    setImageDataUrl("");
    setImageFileName("");
    setImageFile(null);
  }

  function getImageEditInput() {
    const url = imageUrl.trim();
    if (url) return { kind: "url" as const, url, source: url };

    if (imageFile) {
      return {
        kind: "file" as const,
        file: imageFile,
        source: `upload:${imageFile.name || imageFileName || "image"}`,
      };
    }

    return null;
  }

  async function start() {
    setUiError("");

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setUiError("Write a prompt first.");
      return;
    }

    if (mode === "edit" && !videoUrl.trim()) {
      setUiError("Video URL is required for edits.");
      return;
    }

    const pool = enabledKeys;
    if (pool.length === 0) {
      setUiError("Add an API key in API keys (local) first.");
      return;
    }
    let rr = rotationIndex;

    setBusy(true);
    try {
      const imageUrlInput = mode === "generate" ? imageUrl.trim() : "";
      const imageDataInput = mode === "generate" ? imageDataUrl.trim() : "";
      const imageInput = imageUrlInput || imageDataInput;
      const imageHint = imageUrlInput
        ? imageUrlInput
        : imageFile
          ? `upload:${imageFile.name || imageFileName || "image"}`
          : imageDataInput
            ? "upload:image"
            : "";

      const payload: Record<string, unknown> = {
        mode,
        model: MODEL,
        prompt: trimmedPrompt,
        aspect_ratio: aspectRatio,
        resolution,
      };

      if (mode === "generate") {
        payload.duration = duration;
        if (imageInput) payload.image_url = imageInput;
      } else {
        payload.video_url = videoUrl.trim();
      }

      const attempts = pool.length > 0 ? pool.length : 1;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const keyEntry = pool.length > 0 ? pool[rr % pool.length] : null;
        if (keyEntry) rr += 1;

        const headers: HeadersInit = { "Content-Type": "application/json" };
        if (keyEntry) headers["x-xai-api-key"] = keyEntry.key;

        const res = await fetch("/api/video/start", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const data = (await res.json().catch(() => null)) as unknown;

        if (res.ok) {
          const requestId =
            data && typeof data === "object" && "request_id" in data
              ? String((data as { request_id: unknown }).request_id)
              : "";

          if (!requestId) {
            throw new Error("Missing request_id in response.");
          }

          if (keyEntry) {
            setKeyHealth(keyEntry.id, { health: "ok", lastError: undefined });
          }

          const job: VideoJob = {
            requestId,
            mode,
            prompt: trimmedPrompt,
            createdAt: Date.now(),
            status: "processing",
            keyId: keyEntry?.id,
            inputs: {
              duration: mode === "generate" ? duration : undefined,
              aspect_ratio: aspectRatio,
              resolution,
              image_url:
                mode === "generate" ? imageHint || undefined : undefined,
              video_url: mode === "edit" ? videoUrl.trim() : undefined,
            },
          };

          setJobs((prev) => [job, ...prev].slice(0, 25));
          setActiveId(requestId);
          return;
        }

        const msg = stringifyError(data) || res.statusText;
        lastError = new Error(msg);

        if (keyEntry) {
          setKeyHealth(keyEntry.id, {
            health:
              res.status === 401 || res.status === 403
                ? "invalid"
                : res.status === 429
                  ? "rate_limited"
                  : "error",
            lastCheckedAt: Date.now(),
            lastError: msg,
          });
        }

        const retryable =
          (res.status === 401 || res.status === 403 || res.status === 429) &&
          pool.length > 1;
        if (retryable && attempt < attempts - 1) continue;

        throw lastError;
      }

      throw lastError ?? new Error("Request failed.");
    } catch (err) {
      setUiError(stringifyError(err));
    } finally {
      if (pool.length > 0) {
        setRotationIndex(rr % pool.length);
      } else {
        setRotationIndex(0);
      }
      setBusy(false);
    }
  }

  async function startImage() {
    setUiError("");

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setUiError("Write a prompt first.");
      return;
    }

    const imageInput = imageMode === "edit" ? getImageEditInput() : null;
    if (imageMode === "edit" && !imageInput) {
      setUiError("Image is required for edits (URL or upload).");
      return;
    }

    const pool = enabledKeys;
    if (pool.length === 0) {
      setUiError("Add an API key in API keys (local) first.");
      return;
    }
    let rr = rotationIndex;

    setBusy(true);
    try {
      const endpoint =
        imageMode === "edit" ? "/api/image/edit" : "/api/image/generate";

      const attempts = pool.length > 0 ? pool.length : 1;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const keyEntry = pool.length > 0 ? pool[rr % pool.length] : null;
        if (keyEntry) rr += 1;

        let res: Response;

        if (imageMode === "edit" && imageInput?.kind === "file") {
          const form = new FormData();
          form.set("model", IMAGE_MODEL);
          form.set("prompt", trimmedPrompt);
          form.set("response_format", imageResponseFormat);
          form.set("image", imageInput.file, imageInput.file.name || "image");

          const headers: HeadersInit = {};
          if (keyEntry) headers["x-xai-api-key"] = keyEntry.key;

          res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: form,
          });
        } else {
          const payload: Record<string, unknown> = {
            model: IMAGE_MODEL,
            prompt: trimmedPrompt,
            response_format: imageResponseFormat,
          };

          if (imageMode === "generate") {
            payload.aspect_ratio = aspectRatio;
          } else if (imageInput?.kind === "url") {
            payload.image_url = imageInput.url;
          }

          const headers: HeadersInit = { "Content-Type": "application/json" };
          if (keyEntry) headers["x-xai-api-key"] = keyEntry.key;

          res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        }

        const data = (await res.json().catch(() => null)) as unknown;

        if (res.ok) {
          if (keyEntry) {
            setKeyHealth(keyEntry.id, { health: "ok", lastError: undefined });
          }

          const images = extractImageUrls(data).slice(0, 6);
          const error =
            images.length === 0 ? "No image URLs returned." : undefined;

          const job: ImageJob = {
            id: createId(),
            mode: imageMode,
            prompt: trimmedPrompt,
            createdAt: Date.now(),
            status: error ? "error" : "ready",
            keyId: keyEntry?.id,
            inputs: {
              aspect_ratio: imageMode === "generate" ? aspectRatio : undefined,
              response_format: imageResponseFormat,
              image_source: imageMode === "edit" ? imageInput?.source : undefined,
            },
            images,
            raw: data,
            error,
          };

          setImageJobs((prev) => [job, ...prev].slice(0, 25));
          setActiveImageId(job.id);

          if (error) setUiError(error);
          return;
        }

        const msg = stringifyError(data) || res.statusText;
        lastError = new Error(msg);

        if (keyEntry) {
          setKeyHealth(keyEntry.id, {
            health:
              res.status === 401 || res.status === 403
                ? "invalid"
                : res.status === 429
                  ? "rate_limited"
                  : "error",
            lastCheckedAt: Date.now(),
            lastError: msg,
          });
        }

        const retryable =
          (res.status === 401 || res.status === 403 || res.status === 429) &&
          pool.length > 1;
        if (retryable && attempt < attempts - 1) continue;

        throw lastError;
      }

      throw lastError ?? new Error("Request failed.");
    } catch (err) {
      setUiError(stringifyError(err));
    } finally {
      if (pool.length > 0) {
        setRotationIndex(rr % pool.length);
      } else {
        setRotationIndex(0);
      }
      setBusy(false);
    }
  }

  function stopPolling() {
    if (!activeJob || activeJob.status !== "processing") return;
    setJobs((prev) =>
      prev.map((j) =>
        j.requestId === activeJob.requestId ? { ...j, status: "stopped" } : j,
      ),
    );
  }

  function resumePolling() {
    if (!activeJob || activeJob.status !== "stopped") return;
    setJobs((prev) =>
      prev.map((j) =>
        j.requestId === activeJob.requestId ? { ...j, status: "processing" } : j,
      ),
    );
  }

  async function refreshOnce() {
    if (!activeJob) return;
    setUiError("");

    if (!activeApiKey) {
      setUiError("Missing API key for this job. Re-add it in API keys (local).");
      return;
    }

    try {
      const res = await fetch(
        `/api/video/status/${encodeURIComponent(activeJob.requestId)}`,
        {
          cache: "no-store",
          headers: { "x-xai-api-key": activeApiKey },
        },
      );

      if (res.status === 202) {
        const polledAt = Date.now();
        setJobs((prev) =>
          prev.map((j) =>
            j.requestId === activeJob.requestId
              ? { ...j, status: "processing", lastPolledAt: polledAt }
              : j,
          ),
        );
        return;
      }

      const data = (await res.json().catch(() => null)) as unknown;
      const polledAt = Date.now();
      const state = extractState(data);
      const normalizedState = state ? normalizeState(state) : "";

      if (!res.ok) {
        const msg = stringifyError(data) || res.statusText;
        setJobs((prev) =>
          prev.map((j) =>
            j.requestId === activeJob.requestId
              ? {
                  ...j,
                  status: "error",
                  error: msg,
                  raw: data,
                  lastState: state ?? j.lastState,
                  lastPolledAt: polledAt,
                }
              : j,
          ),
        );
        setUiError(msg);
        return;
      }

      const url = extractVideoUrl(data);

      if (normalizedState && FAILURE_STATES.has(normalizedState)) {
        const msg = extractErrorMessage(data) ?? `Request ${state}`;
        setJobs((prev) =>
          prev.map((j) =>
            j.requestId === activeJob.requestId
              ? {
                  ...j,
                  status: "error",
                  error: msg,
                  raw: data,
                  lastState: state ?? j.lastState,
                  lastPolledAt: polledAt,
                }
              : j,
          ),
        );
        setUiError(msg);
        return;
      }

      if (normalizedState && SUCCESS_STATES.has(normalizedState) && !url) {
        const msg =
          extractErrorMessage(data) ?? `Request ${state}, but no URL returned`;
        setJobs((prev) =>
          prev.map((j) =>
            j.requestId === activeJob.requestId
              ? {
                  ...j,
                  status: "error",
                  error: msg,
                  raw: data,
                  lastState: state ?? j.lastState,
                  lastPolledAt: polledAt,
                }
              : j,
          ),
        );
        setUiError(msg);
        return;
      }

      setJobs((prev) =>
        prev.map((j) =>
          j.requestId === activeJob.requestId
            ? {
                ...j,
                status: url ? "ready" : "processing",
                videoUrl: url ?? j.videoUrl,
                raw: data,
                lastState: state ?? j.lastState,
                lastPolledAt: polledAt,
              }
            : j,
        ),
      );
    } catch (err) {
      setUiError(stringifyError(err));
    }
  }

  function clearHistory() {
    setJobs([]);
    setActiveId("");
    setUiError("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function clearImageHistory() {
    setImageJobs([]);
    setActiveImageId("");
    setUiError("");
    try {
      localStorage.removeItem(IMAGE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <div className="pointer-events-none absolute -top-28 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-gradient-to-r from-fuchsia-400/30 via-indigo-400/25 to-cyan-400/30 blur-3xl dark:from-fuchsia-600/20 dark:via-indigo-600/15 dark:to-cyan-600/20" />
      <div className="pointer-events-none absolute -bottom-24 right-[-6rem] h-80 w-80 rounded-full bg-gradient-to-tr from-emerald-300/30 via-sky-300/20 to-transparent blur-3xl dark:from-emerald-500/15 dark:via-sky-500/10" />

      <div className="relative mx-auto max-w-6xl px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              {studio === "video" ? (
                <Film className="h-5 w-5" />
              ) : (
                <ImageIcon className="h-5 w-5" />
              )}
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Grok Imagine</h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {studio === "video" ? "Video Studio" : "Image Studio"} ·{" "}
                <span className="font-mono">
                  {studio === "video" ? MODEL : IMAGE_MODEL}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <button
                type="button"
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-medium transition",
                  studio === "video"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900",
                )}
                onClick={() => setStudio("video")}
                disabled={busy}
              >
                <Film className="h-4 w-4" />
                Video
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-medium transition",
                  studio === "image"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900",
                )}
                onClick={() => setStudio("image")}
                disabled={busy}
              >
                <ImageIcon className="h-4 w-4" />
                Image
              </button>
            </div>
            <ThemeToggle />
            <a
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
              href={
                studio === "video"
                  ? "https://docs.x.ai/docs/guides/video-generation"
                  : "https://docs.x.ai/docs/guides/image-generation"
              }
              target="_blank"
              rel="noreferrer"
            >
              Docs <ArrowUpRight className="h-4 w-4" />
            </a>
          </div>
        </header>

        <main className="mt-7 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>
                    {studio === "video" ? "Create a video request" : "Create an image request"}
                  </CardTitle>
                  <CardDescription>
                    {studio === "video"
                      ? "Requests are deferred. Start a job, then we poll by request id."
                      : "Requests return immediately (no polling)."}
                  </CardDescription>
                </div>

                <div className="inline-flex rounded-2xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-950">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-medium transition",
                      (studio === "video" ? mode : imageMode) === "generate"
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900",
                    )}
                    onClick={() =>
                      studio === "video" ? setMode("generate") : setImageMode("generate")
                    }
                    disabled={busy}
                  >
                    <Wand2 className="h-4 w-4" />
                    Generate
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-medium transition",
                      (studio === "video" ? mode : imageMode) === "edit"
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900",
                    )}
                    onClick={() =>
                      studio === "video" ? setMode("edit") : setImageMode("edit")
                    }
                    disabled={busy}
                  >
                    {studio === "video" ? (
                      <Film className="h-4 w-4" />
                    ) : (
                      <ImageIcon className="h-4 w-4" />
                    )}
                    Edit
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="prompt">Prompt</Label>
                <Textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    studio === "video"
                      ? mode === "generate"
                        ? "A cinematic drone shot over a neon-lit city at night, rain reflections..."
                        : "Stabilize the camera, warmer colors, and make the motion feel smoother..."
                      : imageMode === "generate"
                        ? "A cat in a tree, watercolor, high detail..."
                        : "Swap the cat in the picture with a dog, keep the same style..."
                  }
                  disabled={busy}
                />
              </div>

              {studio === "video" ? (
                mode === "generate" ? (
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="imageUrl">Optional image (image-to-video)</Label>
                      {(imageDataUrl || imageUrl.trim()) && (
                        <button
                          type="button"
                          className="text-xs text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                          onClick={clearImageInput}
                          disabled={busy}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <Input
                      id="imageUrl"
                      value={imageUrl}
                      onChange={(e) => {
                        setImageUrl(e.target.value);
                        setImageDataUrl("");
                        setImageFileName("");
                        setImageFile(null);
                      }}
                      placeholder="https://… (public URL) or upload below"
                      disabled={busy}
                    />

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => onPickImage(e.target.files?.[0])}
                      disabled={busy}
                      className={cn(
                        "w-full cursor-pointer rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm transition",
                        "file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-900",
                        "hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:file:bg-zinc-900 dark:file:text-zinc-50 dark:hover:bg-zinc-900",
                      )}
                    />

                    {(imageDataUrl || imageUrl.trim()) && (
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">
                        {imageDataUrl
                          ? `Using upload: ${imageFileName || "image"} (sent as base64)`
                          : "Using image URL"}
                      </p>
                    )}

                    {imageDataUrl ? (
                      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imageDataUrl}
                          alt="Reference"
                          className="h-auto w-full"
                        />
                      </div>
                    ) : imageUrl.trim() ? (
                      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={imageUrl} alt="Reference" className="h-auto w-full" />
                      </div>
                    ) : null}

                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      Tip: try “animate the provided image, preserve the subject and style”.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="videoUrl">Video URL (required)</Label>
                    <Input
                      id="videoUrl"
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      placeholder="https://… (max ~8.7s; direct link)"
                      disabled={busy}
                    />
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      The input video must be a direct, publicly accessible URL.
                    </p>
                  </div>
                )
              ) : imageMode === "edit" ? (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="imageUrl">Source image (required)</Label>
                    {(imageDataUrl || imageUrl.trim()) && (
                      <button
                        type="button"
                        className="text-xs text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                        onClick={clearImageInput}
                        disabled={busy}
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  <Input
                    id="imageUrl"
                    value={imageUrl}
                    onChange={(e) => {
                      setImageUrl(e.target.value);
                      setImageDataUrl("");
                      setImageFileName("");
                      setImageFile(null);
                    }}
                    placeholder="https://… (public URL) or upload below"
                    disabled={busy}
                  />

                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => onPickImage(e.target.files?.[0])}
                    disabled={busy}
                    className={cn(
                      "w-full cursor-pointer rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm transition",
                      "file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-900",
                      "hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:file:bg-zinc-900 dark:file:text-zinc-50 dark:hover:bg-zinc-900",
                    )}
                  />

                  {(imageDataUrl || imageUrl.trim()) && (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      {imageDataUrl
                        ? `Using upload: ${imageFileName || "image"} (sent as file)`
                        : "Using image URL"}
                    </p>
                  )}

                  {imageDataUrl ? (
                    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Source" className="h-auto w-full" />
                    </div>
                  ) : imageUrl.trim() ? (
                    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageUrl} alt="Source" className="h-auto w-full" />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {studio === "video" ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>Aspect ratio</Label>
                      <select
                        className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-950 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                        value={aspectRatio}
                        onChange={(e) =>
                          setAspectRatio(
                            e.target.value as (typeof ASPECT_RATIOS)[number],
                          )
                        }
                        disabled={busy}
                      >
                        {ASPECT_RATIOS.map((ar) => (
                          <option key={ar} value={ar}>
                            {ar}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid gap-2">
                      <Label>Resolution</Label>
                      <select
                        className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-950 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                        value={resolution}
                        onChange={(e) =>
                          setResolution(
                            e.target.value as (typeof RESOLUTIONS)[number],
                          )
                        }
                        disabled={busy}
                      >
                        {RESOLUTIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label>Duration (seconds)</Label>
                      {mode === "edit" && <Badge>Edits ignore duration</Badge>}
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={15}
                        value={duration}
                        onChange={(e) => setDuration(Number(e.target.value))}
                        disabled={busy || mode === "edit"}
                        className="w-full accent-zinc-900 dark:accent-zinc-50"
                      />
                      <Input
                        type="number"
                        min={1}
                        max={15}
                        value={duration}
                        onChange={(e) => setDuration(Number(e.target.value || 1))}
                        disabled={busy || mode === "edit"}
                        className="w-20"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {imageMode === "generate" && (
                    <div className="grid gap-2">
                      <Label>Aspect ratio</Label>
                      <select
                        className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-950 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                        value={aspectRatio}
                        onChange={(e) =>
                          setAspectRatio(
                            e.target.value as (typeof ASPECT_RATIOS)[number],
                          )
                        }
                        disabled={busy}
                      >
                        {ASPECT_RATIOS.map((ar) => (
                          <option key={ar} value={ar}>
                            {ar}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div
                    className={cn(
                      "grid gap-2",
                      imageMode === "generate" ? "" : "sm:col-span-2",
                    )}
                  >
                    <Label>Output format</Label>
                    <select
                      className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-950 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                      value={imageResponseFormat}
                      onChange={(e) =>
                        setImageResponseFormat(e.target.value as ResponseFormat)
                      }
                      disabled={busy}
                    >
                      <option value="url">url</option>
                      <option value="b64_json">b64_json (base64)</option>
                    </select>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      Use <span className="font-mono">url</span> for hosted images or{" "}
                      <span className="font-mono">b64_json</span> for base64 output.
                    </p>
                  </div>
                </div>
              )}

              {uiError && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                  {uiError}
                </div>
              )}

              <details className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  API keys (local)
                </summary>

                <div className="mt-3 grid gap-4 text-xs text-zinc-600 dark:text-zinc-400">
                  <p>
                    Keys are stored in your browser{" "}
                    <span className="font-mono">localStorage</span> and sent to
                    the server per request.{" "}
                    Don&apos;t store keys in the client for shared deployments.
                  </p>

                  <div className="grid gap-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1">
                        <Label htmlFor="keyLabel">Label (optional)</Label>
                        <Input
                          id="keyLabel"
                          value={newKeyLabel}
                          onChange={(e) => setNewKeyLabel(e.target.value)}
                          placeholder="Main, backup, etc."
                          disabled={busy}
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor="apiKey">API key</Label>
                        <Input
                          id="apiKey"
                          type="password"
                          value={newKeyValue}
                          onChange={(e) => setNewKeyValue(e.target.value)}
                          placeholder="xai-…"
                          autoComplete="off"
                          inputMode="text"
                          disabled={busy}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={addSingleKey}
                        disabled={busy || !newKeyValue.trim()}
                      >
                        Add key
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={checkAllKeys}
                        disabled={busy || checkingKeys || keys.length === 0}
                      >
                        {checkingKeys ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Checking…
                          </>
                        ) : (
                          "Check all"
                        )}
                      </Button>
                      {enabledKeys.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            setRotationIndex(
                              (rotationIndex + 1) % enabledKeys.length,
                            )
                          }
                          disabled={busy}
                        >
                          Rotate next
                        </Button>
                      )}
                      {keys.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setKeys([]);
                            setRotationIndex(0);
                          }}
                          disabled={busy}
                        >
                          Clear keys
                        </Button>
                      )}
                    </div>

                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          Rotation:{" "}
                          {enabledKeys.length > 0
                            ? `${enabledKeys.length} enabled (round‑robin)`
                            : "no enabled keys (add one below)"}
                        </span>
                        {nextKey && (
                          <span className="font-mono">
                            Next: {nextKey.label} ({maskKey(nextKey.key)})
                          </span>
                        )}
                      </div>
                    </div>

                    {keys.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                        No keys saved.
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {keys.map((k) => (
                          <div
                            key={k.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              <input
                                type="checkbox"
                                checked={k.enabled}
                                onChange={() => toggleKeyEnabled(k.id)}
                                disabled={busy}
                                className="mt-1 h-4 w-4 accent-zinc-900 dark:accent-zinc-50"
                                aria-label={`Toggle ${k.label}`}
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                                    {k.label}
                                  </span>
                                  {k.health === "ok" && (
                                    <Badge variant="success">ok</Badge>
                                  )}
                                  {k.health === "invalid" && (
                                    <Badge variant="danger">invalid</Badge>
                                  )}
                                  {k.health === "rate_limited" && (
                                    <Badge variant="warning">rate limited</Badge>
                                  )}
                                  {k.health === "error" && (
                                    <Badge variant="danger">error</Badge>
                                  )}
                                  {k.health === "unknown" && <Badge>unknown</Badge>}
                                  {k.hasGrokImagineVideo === false && (
                                    <Badge variant="warning">no video model</Badge>
                                  )}
                                  {k.hasGrokImagineImage === false && (
                                    <Badge variant="warning">no image model</Badge>
                                  )}
                                </div>
                                <div className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                                  {maskKey(k.key)}
                                </div>
                                {k.lastError && (
                                  <div className="truncate text-xs text-red-700 dark:text-red-200">
                                    {k.lastError}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => checkKey(k.id)}
                                disabled={busy || checkingKeys}
                              >
                                Check
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => void copyToClipboard(k.key)}
                                disabled={busy}
                              >
                                <Copy className="h-4 w-4" />
                                Copy
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => removeKey(k.id)}
                                disabled={busy}
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <details className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
                      <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Bulk add
                      </summary>
                      <div className="mt-3 grid gap-2">
                        <Textarea
                          value={bulkKeys}
                          onChange={(e) => setBulkKeys(e.target.value)}
                          placeholder={"One key per line.\nOptional: label|key"}
                          disabled={busy}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={addBulkKeys}
                            disabled={busy || !bulkKeys.trim()}
                          >
                            Add keys
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setBulkKeys("")}
                            disabled={busy || !bulkKeys}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                    </details>
                  </div>
                </div>
              </details>
            </CardContent>
            <CardFooter>
              <Button onClick={studio === "video" ? start : startImage} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Working…
                  </>
                ) : studio === "video" ? (
                  mode === "generate" ? (
                    <>
                      <Wand2 className="h-4 w-4" />
                      Generate video
                    </>
                  ) : (
                    <>
                      <Film className="h-4 w-4" />
                      Edit video
                    </>
                  )
                ) : imageMode === "generate" ? (
                  <>
                    <Wand2 className="h-4 w-4" />
                    Generate image
                  </>
                ) : (
                  <>
                    <ImageIcon className="h-4 w-4" />
                    Edit image
                  </>
                )}
              </Button>
              {studio === "video" && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={stopPolling}
                    disabled={!activeJob || activeJob.status !== "processing"}
                  >
                    <Square className="h-4 w-4" />
                    Stop
                  </Button>
                </div>
              )}
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Result</CardTitle>
                  <CardDescription>
                    {studio === "video" ? (
                      activeJob ? (
                        <span>
                          {statusBadge}{" "}
                          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-500">
                            {formatRelativeTime(activeJob.createdAt)}
                          </span>
                        </span>
                      ) : (
                        <span>{statusBadge}</span>
                      )
                    ) : activeImageJob ? (
                      <span>
                        {imageStatusBadge}{" "}
                        <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-500">
                          {formatRelativeTime(activeImageJob.createdAt)}
                        </span>
                      </span>
                    ) : (
                      <span>{imageStatusBadge}</span>
                    )}
                  </CardDescription>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={studio === "video" ? clearHistory : clearImageHistory}
                    disabled={studio === "video" ? jobs.length === 0 : imageJobs.length === 0}
                    aria-label="Clear history"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {studio === "video" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={refreshOnce}
                      disabled={!activeJob}
                      aria-label="Refresh status"
                    >
                      <RefreshCcw className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-5">
              {studio === "video" ? (
                !activeJob ? (
                  <div className="rounded-2xl border border-dashed border-zinc-200 p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                    Generate or edit a video to see the result here.
                  </div>
                ) : (
                  <>
                    <div className="grid gap-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          Request id
                        </span>
                        <code className="rounded-lg bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">
                          {activeJob.requestId}
                        </code>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          Mode
                        </span>
                        <span className="font-medium">{activeJob.mode}</span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          Settings
                        </span>
                        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {activeJob.inputs.aspect_ratio} ·{" "}
                          {activeJob.inputs.resolution}
                          {activeJob.inputs.duration
                            ? ` · ${activeJob.inputs.duration}s`
                            : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          Image
                        </span>
                        <span className="max-w-[22rem] truncate font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {activeJob.inputs.image_url ?? "none"}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          API key
                        </span>
                        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {activeKeyEntry
                            ? `${activeKeyEntry.label} (${maskKey(activeKeyEntry.key)})`
                            : activeJob.keyId
                              ? "missing (re-add key)"
                              : "missing (add a key)"}
                        </span>
                      </div>
                    </div>

                    {activeJob.status === "processing" && (
                      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Polling for video…</span>
                          {activeJob.lastState && (
                            <span className="rounded-lg bg-white px-2 py-1 font-mono text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
                              {activeJob.lastState}
                            </span>
                          )}
                        </div>
                        {activeJob.lastPolledAt && (
                          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                            Last update{" "}
                            {formatRelativeTime(activeJob.lastPolledAt)}
                          </div>
                        )}
                      </div>
                    )}

                    {activeJob.status === "stopped" && (
                      <div className="grid gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                        <div>Polling stopped. You can resume or refresh once.</div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" onClick={resumePolling}>
                            Resume polling
                          </Button>
                          <Button variant="ghost" onClick={refreshOnce}>
                            Refresh once
                          </Button>
                        </div>
                      </div>
                    )}

                    {activeJob.status === "error" && (
                      <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                        <div className="flex items-start gap-2">
                          <XCircle className="mt-0.5 h-4 w-4 flex-none" />
                          <div className="grid gap-1">
                            <div className="font-medium">Request failed</div>
                            <div className="break-words">{activeJob.error}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {activeJob.videoUrl && (
                      <div className="grid gap-3">
                        <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
                          <video
                            controls
                            playsInline
                            src={activeJob.videoUrl}
                            className="w-full bg-black"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={activeJob.videoUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Button variant="secondary">
                              <ArrowUpRight className="h-4 w-4" />
                              Open
                            </Button>
                          </a>
                          <Button
                            variant="ghost"
                            onClick={() => copyToClipboard(activeJob.videoUrl!)}
                          >
                            <Copy className="h-4 w-4" />
                            Copy URL
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => copyToClipboard(activeJob.requestId)}
                          >
                            <Copy className="h-4 w-4" />
                            Copy id
                          </Button>
                          <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                            <CheckCircle2 className="h-4 w-4" />
                            Done
                          </span>
                        </div>
                      </div>
                    )}

                    {activeJob.raw !== undefined && (
                      <details className="rounded-2xl border border-zinc-200 bg-white p-4 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                        <summary className="cursor-pointer select-none font-medium">
                          Raw response
                        </summary>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words font-mono">
                          {JSON.stringify(activeJob.raw, null, 2)}
                        </pre>
                      </details>
                    )}
                  </>
                )
              ) : !activeImageJob ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                  Generate or edit an image to see the result here.
                </div>
              ) : (
                <>
                  <div className="grid gap-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-zinc-600 dark:text-zinc-400">Mode</span>
                      <span className="font-medium">{activeImageJob.mode}</span>
                    </div>

                    {activeImageJob.inputs.aspect_ratio && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          Aspect ratio
                        </span>
                        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {activeImageJob.inputs.aspect_ratio}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-zinc-600 dark:text-zinc-400">Output</span>
                      <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                        {activeImageJob.inputs.response_format ?? "url"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-zinc-600 dark:text-zinc-400">Image</span>
                      <span className="max-w-[22rem] truncate font-mono text-xs text-zinc-700 dark:text-zinc-200">
                        {activeImageJob.inputs.image_source ??
                          (activeImageJob.mode === "edit" ? "provided" : "none")}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-zinc-600 dark:text-zinc-400">API key</span>
                      <span className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                        {activeImageKeyEntry
                          ? `${activeImageKeyEntry.label} (${maskKey(activeImageKeyEntry.key)})`
                          : activeImageJob.keyId
                            ? "missing (re-add key)"
                            : "missing (add a key)"}
                      </span>
                    </div>
                  </div>

                  {activeImageJob.status === "error" && (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                      <div className="flex items-start gap-2">
                        <XCircle className="mt-0.5 h-4 w-4 flex-none" />
                        <div className="grid gap-1">
                          <div className="font-medium">Request failed</div>
                          <div className="break-words">{activeImageJob.error}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeImageJob.images && activeImageJob.images.length > 0 && (
                    <div className="grid gap-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {activeImageJob.images.map((src) => (
                          <div key={src} className="grid gap-2">
                            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={src} alt="Result" className="h-auto w-full" />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <a href={src} target="_blank" rel="noreferrer">
                                <Button variant="secondary">
                                  <ArrowUpRight className="h-4 w-4" />
                                  Open
                                </Button>
                              </a>
                              <Button
                                variant="ghost"
                                onClick={() => copyToClipboard(src)}
                              >
                                <Copy className="h-4 w-4" />
                                Copy
                              </Button>
                              <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                                <CheckCircle2 className="h-4 w-4" />
                                Done
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeImageJob.raw !== undefined && (
                    <details className="rounded-2xl border border-zinc-200 bg-white p-4 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                      <summary className="cursor-pointer select-none font-medium">
                        Raw response
                      </summary>
                      <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words font-mono">
                        {JSON.stringify(activeImageJob.raw, null, 2)}
                      </pre>
                    </details>
                  )}
                </>
              )}

              {studio === "video"
                ? jobs.length > 0 && (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold">History</h3>
                        <span className="text-xs text-zinc-500 dark:text-zinc-500">
                          {jobs.length} saved
                        </span>
                      </div>

                      <div className="grid gap-2">
                        {jobs.map((j) => (
                          <button
                            key={j.requestId}
                            type="button"
                            onClick={() => setActiveId(j.requestId)}
                            className={cn(
                              "group rounded-2xl border px-4 py-3 text-left transition",
                              j.requestId === activeJob?.requestId
                                ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                                : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="grid gap-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">
                                    {j.mode === "generate" ? "Generate" : "Edit"}
                                  </span>
                                  {j.status === "ready" && (
                                    <Badge variant="success">ready</Badge>
                                  )}
                                  {j.status === "processing" && (
                                    <Badge variant="warning">processing</Badge>
                                  )}
                                  {j.status === "stopped" && <Badge>stopped</Badge>}
                                  {j.status === "error" && (
                                    <Badge variant="danger">error</Badge>
                                  )}
                                </div>
                                <p className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                                  {j.prompt}
                                </p>
                              </div>
                              <span className="text-xs text-zinc-500 dark:text-zinc-500">
                                {formatRelativeTime(j.createdAt)}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                : imageJobs.length > 0 && (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold">History</h3>
                        <span className="text-xs text-zinc-500 dark:text-zinc-500">
                          {imageJobs.length} saved
                        </span>
                      </div>

                      <div className="grid gap-2">
                        {imageJobs.map((j) => (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => setActiveImageId(j.id)}
                            className={cn(
                              "group rounded-2xl border px-4 py-3 text-left transition",
                              j.id === activeImageJob?.id
                                ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                                : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="grid gap-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">
                                    {j.mode === "generate" ? "Generate" : "Edit"}
                                  </span>
                                  {j.status === "ready" && (
                                    <Badge variant="success">ready</Badge>
                                  )}
                                  {j.status === "error" && (
                                    <Badge variant="danger">error</Badge>
                                  )}
                                </div>
                                <p className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                                  {j.prompt}
                                </p>
                              </div>
                              <span className="text-xs text-zinc-500 dark:text-zinc-500">
                                {formatRelativeTime(j.createdAt)}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
            </CardContent>
          </Card>
        </main>

        <footer className="mt-8 text-xs text-zinc-500 dark:text-zinc-500">
          Tip: add an API key under{" "}
          <span className="font-semibold">API keys</span> to start generating.
        </footer>
      </div>
    </div>
  );
}
