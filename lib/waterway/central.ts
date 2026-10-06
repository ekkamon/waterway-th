import { CENTRAL_BASINS, damRiverKey, riverKeyOf } from './basin';
import { readSuanThepGauge } from './cctv-gauge';
import type {
  CentralPayload,
  CentralStation,
  DamStation,
  Situation,
} from './types';

const HII_BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; aegis-portal)' };
// Gauges report hourly. A reading much older than that means the station is down: ThaiWater keeps
// serving the frozen value and its situation_level, so the only tell is the timestamp.
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// Dam figures are published once a day and ship inside a ~10 MB feed, so refetch rarely.
const DAM_REFRESH_MS = 60 * 60 * 1000;

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toIso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00` : null;
};

function normalizeStation(r: Raw): CentralStation | null {
  const basin: string | undefined = r.basin?.basin_name?.th;
  if (!basin || !CENTRAL_BASINS.has(basin)) return null;
  const st = r.station ?? {};
  const lat = toNum(st.tele_station_lat);
  const lng = toNum(st.tele_station_long);
  if (lat == null || lng == null || st.id == null) return null;
  const level = toNum(r.waterlevel_msl);
  const situation = toNum(r.situation_level);
  const updatedAt = toIso(r.waterlevel_datetime);
  const stale =
    updatedAt == null ||
    Date.now() - new Date(updatedAt).getTime() > STALE_AFTER_MS;
  const river =
    typeof r.river_name === 'string' ? r.river_name.trim() || null : null;

  return {
    id: `tw-${st.id}`,
    code: st.tele_station_oldcode ?? null,
    name: st.tele_station_name?.th ?? st.tele_station_name?.en ?? '-',
    province: r.geocode?.province_name?.th ?? '-',
    district: r.geocode?.amphoe_name?.th ?? null,
    basin,
    river,
    riverKey: riverKeyOf(river),
    lat,
    lng,
    level,
    previous: toNum(r.waterlevel_msl_previous),
    bankMin: toNum(st.min_bank),
    groundLevel: toNum(st.ground_level),
    bankPercent: toNum(r.storage_percent),
    discharge: toNum(r.discharge),
    stale,
    situation:
      !stale &&
      level != null &&
      situation != null &&
      situation >= 1 &&
      situation <= 5
        ? (situation as Situation)
        : null,
    isKey: st.is_key_station === true,
    updatedAt,
    agency: r.agency?.agency_shortname?.th
      ? `${r.agency.agency_shortname.th} (ThaiWater/สสน.)`
      : 'ThaiWater/สสน.',
    graphStationId: toNum(st.id),
  };
}

function normalizeDam(r: Raw): DamStation | null {
  const basin: string | undefined = r.basin?.basin_name?.th;
  if (!basin || !CENTRAL_BASINS.has(basin)) return null;
  const d = r.dam ?? {};
  const lat = toNum(d.dam_lat);
  const lng = toNum(d.dam_long);
  if (lat == null || lng == null || d.id == null) return null;
  // Only a handful of EGAT-operated dams publish a snapshot, and a couple of those are
  // plain http:// (mixed content, blocked on our https page) — keep https only.
  const cctvUrl =
    typeof r.cctv?.url === 'string' && r.cctv.url.startsWith('https://')
      ? r.cctv.url
      : null;
  return {
    id: `dam-${d.id}`,
    cctvUrl,
    name: d.dam_name?.th ?? d.dam_name?.en ?? '-',
    nameEn: d.dam_name?.en ?? null,
    province: r.geocode?.province_name?.th ?? '-',
    basin,
    riverKey: damRiverKey(basin),
    lat,
    lng,
    storage: toNum(r.dam_storage),
    storagePercent: toNum(r.dam_storage_percent),
    usable: toNum(r.dam_uses_water),
    usablePercent: toNum(r.dam_uses_water_percent),
    inflow: toNum(r.dam_inflow),
    released: toNum(r.dam_released),
    spilled: toNum(r.dam_spilled),
    maxStorage: toNum(d.max_storage),
    normalStorage: toNum(d.normal_storage),
    date: typeof r.dam_date === 'string' ? r.dam_date : null,
  };
}

// ThaiWater has no gauge at the Suan Thep Pathum embankment (ต.บางปรอก อ.เมืองปทุมธานี), but the
// municipality's CCTV watches a staff gauge there: we read the staff from the video and keep the
// frame it was read from as a snapshot. Bank 2.57 m is DWR's bank at สะพานปทุมธานี 1, the nearest
// real gauge (see fetchDwrStation).
const SUANTHEP_ID = 'cctv-suanthep';
const SUANTHEP_BANK_M = 2.57;
// The stream updates every minute, so a reading older than this means the camera or link is down.
const CCTV_STALE_MS = 30 * 60 * 1000;

function situationFor(
  level: number | null,
  stale: boolean,
  bank: number,
): Situation | null {
  if (stale || level == null) return null;
  return level >= bank ? 5 : level >= bank - 0.3 ? 4 : 3;
}

async function fetchSuanThep(
  previous: CentralStation | null,
): Promise<CentralStation> {
  let reading: Awaited<ReturnType<typeof readSuanThepGauge>> | null = null;
  try {
    reading = await readSuanThepGauge();
  } catch (error) {
    console.error(
      '[waterway-cron] cctv suanthep failed:',
      error instanceof Error ? error.message : error,
    );
  }

  // On a failed read keep the last good value, flagged stale so it is not trusted or coloured.
  const level = reading?.level ?? previous?.level ?? null;
  const updatedAt = reading?.updatedAt ?? previous?.updatedAt ?? null;
  const stale =
    updatedAt == null ||
    Date.now() - new Date(updatedAt).getTime() > CCTV_STALE_MS;
  const moved = previous != null && previous.updatedAt !== updatedAt;

  return {
    id: SUANTHEP_ID,
    code: 'CCTV-STP',
    name: 'เขื่อนสวนเทพปทุมเฉลิมพระเกียรติฯ (CCTV)',
    province: 'ปทุมธานี',
    district: 'เมืองปทุมธานี',
    basin: 'ลุ่มน้ำเจ้าพระยา',
    river: 'แม่น้ำเจ้าพระยา',
    riverKey: 'chaophraya',
    lat: 14.02283238,
    lng: 100.53555608,
    level,
    previous: moved ? (previous?.level ?? null) : (previous?.previous ?? null),
    bankMin: SUANTHEP_BANK_M,
    groundLevel: null,
    bankPercent: null,
    discharge: null,
    stale,
    situation: situationFor(level, stale, SUANTHEP_BANK_M),
    isKey: true, // shown from the overview zoom, not only once zoomed into the reach
    updatedAt,
    agency: 'เทศบาลเมืองปทุมธานี (ค่าประมาณจากภาพกล้อง CCTV)',
    graphStationId: null,
    // Only offered once a frame has actually been saved by a successful read.
    snapshotUrl:
      reading || previous?.snapshotUrl ? '/api/waterway/cctv/suanthep' : null,
  };
}

// DWR (กรมทรัพยากรน้ำ) telemetry is not part of the ThaiWater feed, but has a public API.
// สะพานปทุมธานี 1 (TA100219, ต.บางปรอก) is a real level sensor. สะพานปทุมธานี 2 (TC100224, ต.บ้านใหม่)
// currently publishes no level (wlEnabled=false) and its camera shows no staff gauge, so it is
// listed with its camera picture only; it picks up a level automatically if DWR ever enables one.
export const DWR_API = 'https://telemetry.dwr.go.th/api';
const DWR_STALE_MS = 3 * 60 * 60 * 1000;

const DWR_STATIONS = [
  // UTM 47N 666240.7 E / 1551043.6 N -> WGS84
  {
    code: 'TA100219',
    lat: 14.0251,
    lng: 100.5394,
    name: 'สะพานปทุมธานี 1',
    district: 'เมืองปทุมธานี',
  },
  // UTM 47N 665905.2 E / 1544480.7 N -> WGS84
  {
    code: 'TC100224',
    lat: 13.9658,
    lng: 100.5359,
    name: 'สะพานปทุมธานี 2',
    district: 'เมืองปทุมธานี',
  },
] as const;
export const DWR_CODES: readonly string[] = DWR_STATIONS.map((s) => s.code);

// DWR keeps ~5 days of hourly levels per station (the chart on its own site). Oldest first.
export async function fetchDwrSeries(
  code: string,
): Promise<[number, number][]> {
  const res = await fetch(`${DWR_API}/public/station/getByCode/${code}`, {
    headers: HEADERS,
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DWR ${code} -> HTTP ${res.status}`);
  const past: Raw[] = ((await res.json()) as Raw).value?.wlChart?.past ?? [];
  return past
    .map((p) => [Date.parse(p.date), toNum(p.value)] as const)
    .filter(
      (p): p is readonly [number, number] =>
        !Number.isNaN(p[0]) && p[1] != null,
    )
    .map(([t, v]) => [t, v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

async function fetchDwrStation(
  cfg: (typeof DWR_STATIONS)[number],
  previous: CentralStation | null,
): Promise<CentralStation | null> {
  const id = `dwr-${cfg.code}`;
  try {
    const res = await fetch(`${DWR_API}/public/station/getByCode/${cfg.code}`, {
      headers: HEADERS,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = ((await res.json()) as Raw).value ?? {};
    const cur = v.stationCurrentData ?? {};
    const e = v.fullCon?.entity ?? {};
    const level = toNum(cur.wl);
    const t =
      typeof cur.wlTimeStamp === 'string' ? Date.parse(cur.wlTimeStamp) : NaN;
    const hasLevel = level != null && !Number.isNaN(t);
    const updatedAt = hasLevel ? new Date(t).toISOString() : null;
    const banks = [toNum(e.lbMsl), toNum(e.rbMsl)].filter(
      (n): n is number => n != null,
    );
    // A station without surveyed banks (TC100224) falls back to DWR's critical level, which on
    // TA100219 (2.54) sits within 3 cm of its lowest bank (2.57).
    const bankMin = banks.length ? Math.min(...banks) : toNum(e.wlFc);
    // No level telemetry is not a fault: show "no data" rather than the "station down" state.
    const stale = hasLevel && Date.now() - t > DWR_STALE_MS;
    const moved = previous != null && previous.updatedAt !== updatedAt;
    return {
      id,
      code: cfg.code,
      name: e.stnNameTh ?? cfg.name,
      province: 'ปทุมธานี',
      district: cfg.district,
      basin: 'ลุ่มน้ำเจ้าพระยา',
      river: 'แม่น้ำเจ้าพระยา',
      riverKey: 'chaophraya',
      lat: cfg.lat,
      lng: cfg.lng,
      level: hasLevel ? level : null,
      previous: moved
        ? (previous?.level ?? null)
        : (previous?.previous ?? null),
      bankMin,
      groundLevel: toNum(e.bbMsl),
      bankPercent: null,
      discharge: null,
      stale,
      situation:
        hasLevel && bankMin != null
          ? situationFor(level, stale, bankMin)
          : null,
      isKey: true,
      updatedAt,
      agency: hasLevel
        ? 'กรมทรัพยากรน้ำ (DWR Telemetry)'
        : 'กรมทรัพยากรน้ำ (DWR) · ไม่มีค่าระดับน้ำ มีเฉพาะภาพกล้อง',
      graphStationId: null,
      snapshotUrl: e.cctvEnabled ? `/api/waterway/cctv/dwr/${cfg.code}` : null,
    };
  } catch (error) {
    console.error(
      `[waterway-cron] dwr ${cfg.code} failed:`,
      error instanceof Error ? error.message : error,
    );
    // Keep the last value but flag it stale; it recovers on the next successful poll.
    return previous
      ? { ...previous, stale: previous.level != null, situation: null }
      : null;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HII_BASE}/${path}`, {
    headers: HEADERS,
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ThaiWater ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchDams(): Promise<DamStation[]> {
  const json = await getJson<{ dam?: { data?: { data?: Raw[] } } }>(
    'thailand_main',
  );
  return (json.dam?.data?.data ?? [])
    .map(normalizeDam)
    .filter((v): v is DamStation => v !== null);
}

export async function fetchCentral(
  previous: CentralPayload | null,
): Promise<CentralPayload> {
  const damsFresh =
    previous?.damsFetchedAt != null &&
    previous.dams.length > 0 &&
    Date.now() - new Date(previous.damsFetchedAt).getTime() < DAM_REFRESH_MS;

  const [levels, dams, suanThep, ...dwr] = await Promise.all([
    getJson<{ waterlevel_data?: { data?: Raw[] } }>('waterlevel_load'),
    damsFresh
      ? Promise.resolve(null)
      : fetchDams().catch((error) => {
          console.error(
            '[waterway-cron] central dams failed:',
            error instanceof Error ? error.message : error,
          );
          return null;
        }),
    fetchSuanThep(previous?.stations.find((s) => s.id === SUANTHEP_ID) ?? null),
    ...DWR_STATIONS.map((cfg) =>
      fetchDwrStation(
        cfg,
        previous?.stations.find((s) => s.id === `dwr-${cfg.code}`) ?? null,
      ),
    ),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    damsFetchedAt: dams
      ? new Date().toISOString()
      : (previous?.damsFetchedAt ?? null),
    dams: dams ?? previous?.dams ?? [],
    stations: (levels.waterlevel_data?.data ?? [])
      .map(normalizeStation)
      .filter((v): v is CentralStation => v !== null)
      .concat(
        suanThep,
        dwr.filter((v): v is CentralStation => v !== null),
      ),
  };
}
