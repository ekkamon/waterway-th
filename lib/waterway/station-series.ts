import { fetchDwrSeries } from "./central";
import { readStationHistory } from "./snapshot";

/** [epoch ms, level] oldest first, for stations that have no ThaiWater graph (DWR and CCTV-read ones). */
export function readStationSeries(id: string): Promise<[number, number][]> {
  return id.startsWith("dwr-") ? fetchDwrSeries(id.slice(4)) : readStationHistory(id);
}

export const isSelfSeriesId = (id: string) => /^(dwr|cctv)-[A-Za-z0-9]+$/.test(id);
