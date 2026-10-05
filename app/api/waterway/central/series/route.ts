import { isSelfSeriesId, readStationSeries } from "@/lib/waterway/station-series";
import type { GraphPoint } from "@/lib/waterway/types";

export const dynamic = "force-dynamic";

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Last 3 days of levels for a DWR or CCTV-read station — the same shape as the ThaiWater graph
// route, so the station panel can chart it the same way.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isSelfSeriesId(id)) return Response.json({ message: "invalid id" }, { status: 400 });
  try {
    const since = Date.now() - WINDOW_MS;
    const points: GraphPoint[] = (await readStationSeries(id))
      .filter(([t]) => t >= since)
      .map(([t, value]) => ({ time: new Date(t).toISOString(), value }));
    return Response.json(points, { headers: { "Cache-Control": "public, s-maxage=120" } });
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : "upstream error" },
      { status: 502 },
    );
  }
}
