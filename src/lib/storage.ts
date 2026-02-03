import fs from "fs/promises";
import path from "path";

const JOBS_DIR = path.join(process.cwd(), ".jobs");

async function ensureDir() {
  try {
    await fs.access(JOBS_DIR);
  } catch {
    await fs.mkdir(JOBS_DIR, { recursive: true });
  }
}

export async function saveJob(type: "video" | "image", id: string, data: any) {
  await ensureDir();
  const filePath = path.join(JOBS_DIR, `${type}-${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function listJobs(type: "video" | "image") {
  await ensureDir();
  const files = await fs.readdir(JOBS_DIR);
  const typeFiles = files.filter((f) => f.startsWith(`${type}-`) && f.endsWith(".json"));

  const jobs = await Promise.all(
    typeFiles.map(async (f) => {
      try {
        const content = await fs.readFile(path.join(JOBS_DIR, f), "utf-8");
        return JSON.parse(content);
      } catch {
        return null;
      }
    })
  );

  return jobs
    .filter((j) => j !== null)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function deleteJob(type: "video" | "image", id: string) {
  await ensureDir();
  const filePath = path.join(JOBS_DIR, `${type}-${id}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

export async function getJob(type: "video" | "image", id: string) {
  await ensureDir();
  const filePath = path.join(JOBS_DIR, `${type}-${id}.json`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function updateJob(type: "video" | "image", id: string, patch: any) {
  const existing = await getJob(type, id);
  if (!existing) return;
  await saveJob(type, id, { ...existing, ...patch });
}

export async function clearJobs(type: "video" | "image") {
  await ensureDir();
  const files = await fs.readdir(JOBS_DIR);
  const typeFiles = files.filter((f) => f.startsWith(`${type}-`) && f.endsWith(".json"));
  await Promise.all(typeFiles.map((f) => fs.unlink(path.join(JOBS_DIR, f))));
}
