import { NextResponse } from "next/server";
import { listJobs, clearJobs } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") as "video" | "image";

  if (type !== "video" && type !== "image") {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  try {
    const jobs = await listJobs(type);
    return NextResponse.json(jobs);
  } catch (err) {
    return NextResponse.json({ error: "Failed to list jobs" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") as "video" | "image";

  if (type !== "video" && type !== "image") {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  try {
    await clearJobs(type);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Failed to clear jobs" }, { status: 500 });
  }
}
