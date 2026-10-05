import { DWR_API, DWR_CODES } from "@/lib/waterway/central";

export const dynamic = "force-dynamic";

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; aegis-portal)" };

// Latest still from a DWR telemetry station camera (สะพานปทุมธานี 1/2). DWR stores the newest
// frame under a dated path, so look the path up first, then fetch the image from its file API.
export async function GET(_request: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!DWR_CODES.includes(code)) return Response.json({ message: "unknown station" }, { status: 404 });
  try {
    const detail = await fetch(`${DWR_API}/public/station/getByCode/${code}`, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const path = ((await detail.json()) as { value?: { fullCon?: { entity?: { cctvLatestSnapshotPath?: string } } } })
      .value?.fullCon?.entity?.cctvLatestSnapshotPath;
    if (!path) throw new Error("no snapshot path");
    const img = await fetch(`${DWR_API}/file/image/cctv`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!img.ok) throw new Error(`image HTTP ${img.status}`);
    return new Response(await img.arrayBuffer(), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=60" },
    });
  } catch {
    return Response.json({ message: "ไม่พบภาพจากกล้อง" }, { status: 404 });
  }
}
