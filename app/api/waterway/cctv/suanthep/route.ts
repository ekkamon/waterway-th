import { readFile } from "node:fs/promises";

import { SUANTHEP_SNAPSHOT_FILE } from "@/lib/waterway/cctv-gauge";

export const dynamic = "force-dynamic";

// Latest still from the Suan Thep Pathum staff-gauge camera — the exact frame the level was read from.
export async function GET() {
  try {
    const jpeg = await readFile(SUANTHEP_SNAPSHOT_FILE);
    return new Response(new Uint8Array(jpeg), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=60" },
    });
  } catch {
    return Response.json({ message: "ยังไม่มีภาพจากกล้อง" }, { status: 404 });
  }
}
