import { attributionOf } from '../sources.js';
import type { HttpClient } from '../http.js';
import { SourceError, sanitizeExternalText } from '../http.js';
import type { Alert, Bbox } from '../types.js';

const NWS_ACTIVE = 'https://api.weather.gov/alerts/active';
const INMET_ACTIVE = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';

/**
 * Official texts carry the instruction at the end ("TAKE COVER NOW"), so the
 * default 8000-char cap of `sanitizeExternalText` is raised: truncating the
 * instruction of a long warning would be worse than a larger payload.
 */
const OFFICIAL_TEXT_MAX_CHARS = 20_000;

/** Parameters of NWS impact-based warnings (IBW) that are surfaced as tags. */
const IBW_KEYS = [
  'tornadoDetection',
  'tornadoDamageThreat',
  'thunderstormDamageThreat',
  'windThreat',
  'maxWindGust',
  'hailThreat',
  'maxHailSize',
  'flashFloodDetection',
  'flashFloodDamageThreat',
  'waterspoutDetection',
  'snowSquallDetection',
  'snowSquallImpact',
] as const;

const NWS_SEVERITIES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;

// ---------------------------------------------------------------------------
// Small geometry helpers (also used by severe.ts). GeoJSON order: [lon, lat].
// ---------------------------------------------------------------------------

export type Ring = [number, number][];
export interface GeoGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoGeometry[];
}

function toRing(raw: unknown): Ring {
  if (!Array.isArray(raw)) return [];
  const ring: Ring = [];
  for (const p of raw as unknown[]) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
      ring.push([p[0], p[1]]);
    }
  }
  return ring;
}

/** Every polygon of a geometry as a list of rings (outer ring first, then holes). */
export function polygonsOf(geom: GeoGeometry | null | undefined): Ring[][] {
  if (!geom) return [];
  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
    return [(geom.coordinates as unknown[]).map(toRing)];
  }
  if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    return (geom.coordinates as unknown[]).map((poly) =>
      Array.isArray(poly) ? (poly as unknown[]).map(toRing) : [],
    );
  }
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    return geom.geometries.flatMap((g) => polygonsOf(g));
  }
  return [];
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const crosses =
      a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True when the point is inside the outer ring and outside every hole. */
export function geometryContainsPoint(
  geom: GeoGeometry | null | undefined,
  lon: number,
  lat: number,
): boolean {
  for (const rings of polygonsOf(geom)) {
    const [outer, ...holes] = rings;
    if (outer === undefined || outer.length < 3) continue;
    if (inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h))) return true;
  }
  return false;
}

function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d = (a: [number, number], b: [number, number], c: [number, number]): number =>
    (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True when any polygon of the geometry overlaps the box (outer rings only). */
export function geometryIntersectsBbox(geom: GeoGeometry | null | undefined, bbox: Bbox): boolean {
  const [w, s, e, n] = bbox;
  const corners: Ring = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
  for (const rings of polygonsOf(geom)) {
    const outer = rings[0];
    if (outer === undefined || outer.length < 3) continue;
    if (outer.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)) return true;
    if (corners.some(([x, y]) => inRing(x, y, outer))) return true;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      if (a === undefined || b === undefined) continue;
      for (let k = 0; k < 4; k++) {
        const c = corners[k];
        const dd = corners[(k + 1) % 4];
        if (c !== undefined && dd !== undefined && segmentsIntersect(a, b, c, dd)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Coverage gates. Cheap pre-checks that avoid pointless requests; the
// authoritative answer still comes from the source (NWS answers 400 for
// points outside its area).
// ---------------------------------------------------------------------------

function nwsMayCover(lat: number, lon: number): boolean {
  // US states, territories and adjacent waters: Atlantic/Caribbean/Gulf side up to
  // -60, Pacific side from Guam eastwards across the antimeridian, American Samoa.
  const north = lat >= 10 && lat <= 72 && (lon <= -60 || lon >= 144);
  const samoa = lat >= -15 && lat <= -10 && lon <= -165;
  return north || samoa;
}

function nwsMayCoverBbox(b: Bbox): boolean {
  const [w, s, e, n] = b;
  const latOk = n >= 10 && s <= 72;
  const lonOk = w <= -60 || e >= 144;
  return (latOk && lonOk) || (s <= -10 && n >= -15 && w <= -165);
}

/** South America with margin. The INMET feed is Brazilian; polygons decide the rest. */
function inmetMayCover(lat: number, lon: number): boolean {
  return lat >= -35 && lat <= 6 && lon >= -75 && lon <= -33;
}

function inmetMayCoverBbox(b: Bbox): boolean {
  return b[3] >= -35 && b[1] <= 6 && b[2] >= -75 && b[0] <= -33;
}

// ---------------------------------------------------------------------------
// NWS
// ---------------------------------------------------------------------------

interface NwsProperties {
  id?: string;
  '@id'?: string;
  event?: string;
  severity?: string | null;
  urgency?: string | null;
  certainty?: string | null;
  headline?: string | null;
  description?: string | null;
  instruction?: string | null;
  areaDesc?: string | null;
  onset?: string | null;
  effective?: string | null;
  expires?: string | null;
  ends?: string | null;
  status?: string | null;
  affectedZones?: string[];
  parameters?: Record<string, unknown>;
}

interface NwsFeature {
  geometry?: GeoGeometry | null;
  properties?: NwsProperties;
}

interface NwsCollection {
  features?: NwsFeature[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function joinOfficialText(parts: (string | undefined)[], fallback: string): string {
  const text = parts.filter((p): p is string => p !== undefined).join('\n\n');
  return sanitizeExternalText(text === '' ? fallback : text, OFFICIAL_TEXT_MAX_CHARS);
}

function paramValue(
  parameters: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = parameters?.[key];
  if (Array.isArray(raw)) {
    const parts = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return str(raw);
}

export function nwsFeatureToAlert(feature: NwsFeature): Alert | null {
  const p = feature.properties;
  if (p === undefined) return null;
  // `Test`, `Exercise`, `System`, `Draft` messages are not warnings.
  if (p.status !== undefined && p.status !== null && p.status !== 'Actual') return null;
  const event = str(p.event);
  const id = str(p.id) ?? str(p['@id']);
  if (event === undefined || id === undefined) return null;

  const tags: string[] = [];
  for (const key of IBW_KEYS) {
    const value = paramValue(p.parameters, key);
    if (value !== undefined) tags.push(`${key}: ${sanitizeExternalText(value, 120)}`);
  }

  const alert: Alert = {
    id,
    event: sanitizeExternalText(event, 200),
    tags,
    text: joinOfficialText(
      [str(p.headline), str(p.description), str(p.instruction)],
      paramValue(p.parameters, 'NWSheadline') ?? event,
    ),
    attribution: attributionOf('nws'),
  };
  const severity = str(p.severity);
  if (severity !== undefined) alert.severity = severity;
  const urgency = str(p.urgency);
  if (urgency !== undefined) alert.urgency = urgency;
  const certainty = str(p.certainty);
  if (certainty !== undefined) alert.certainty = certainty;
  const area = str(p.areaDesc);
  if (area !== undefined) alert.areaDescription = sanitizeExternalText(area, 1000);
  const onset = str(p.onset);
  if (onset !== undefined) alert.onset = onset;
  // `ends` is when the hazard ends; `expires` only when this message lapses.
  const expires = str(p.ends) ?? str(p.expires);
  if (expires !== undefined) alert.expires = expires;
  const url = str(p['@id']);
  if (url !== undefined && url.startsWith('https://')) alert.url = url;
  return alert;
}

const SEVERITY_RANK: Record<string, number> = {
  extreme: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
};

function nwsSeverityParam(severity: string[] | undefined): string | undefined {
  if (severity === undefined || severity.length === 0) return undefined;
  const mapped: string[] = [];
  for (const s of severity) {
    const hit = NWS_SEVERITIES.find((x) => x.toLowerCase() === s.trim().toLowerCase());
    if (hit === undefined) return undefined; // a non-NWS label would make the API answer 400
    mapped.push(hit);
  }
  return mapped.join(',');
}

type SourceOutcome =
  | { state: 'ok'; alerts: Alert[]; note?: string }
  | { state: 'outside' }
  | { state: 'failed'; reason: string };

/**
 * Per-source result, so a caller can tell an empty list that means "nobody
 * issued a warning" from one that means "the source that would have told us
 * is down". Reporting the second as the first is a false all-clear.
 */
export interface ConsultedSource {
  source: 'nws' | 'inmet' | 'meteoalarm';
  state: 'ok' | 'outside' | 'failed';
  reason?: string;
}

async function queryNws(
  http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox; severity?: string[] },
): Promise<SourceOutcome> {
  const params = new URLSearchParams();
  const hasPoint = input.lat !== undefined && input.lon !== undefined;
  if (hasPoint) {
    params.set('point', `${(input.lat as number).toFixed(4)},${(input.lon as number).toFixed(4)}`);
  }
  const sev = nwsSeverityParam(input.severity);
  if (sev !== undefined) params.set('severity', sev);
  const qs = params.toString();

  let body: NwsCollection;
  try {
    body = await http.json<NwsCollection>(qs === '' ? NWS_ACTIVE : `${NWS_ACTIVE}?${qs}`);
  } catch (err) {
    if (hasPoint && err instanceof SourceError && err.status === 400) return { state: 'outside' };
    return { state: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }

  const alerts: Alert[] = [];
  let zoneOnly = 0;
  for (const feature of body.features ?? []) {
    const alert = nwsFeatureToAlert(feature);
    if (alert === null) continue;
    if (!hasPoint && input.bbox !== undefined) {
      // The API has no bbox filter, so geometry is matched here. Alerts defined
      // only by zone (watches, marine, most advisories) carry no polygon.
      if (feature.geometry === null || feature.geometry === undefined) {
        zoneOnly++;
        continue;
      }
      if (!geometryIntersectsBbox(feature.geometry, input.bbox)) continue;
    }
    alerts.push(alert);
  }
  return zoneOnly > 0 ? { state: 'ok', alerts, note: `${zoneOnly}` } : { state: 'ok', alerts };
}

// ---------------------------------------------------------------------------
// INMET (Brazil)
// ---------------------------------------------------------------------------

interface InmetAviso {
  id?: number;
  descricao?: string;
  severidade?: string;
  inicio?: string;
  fim?: string;
  poligono?: string | null;
  municipios?: string | null;
  estados?: string | null;
  riscos?: string[] | null;
  instrucoes?: string[] | null;
  encerrado?: boolean | null;
}

interface InmetResponse {
  hoje?: InmetAviso[];
  futuro?: InmetAviso[];
}

function parsePolygon(raw: string | null | undefined): GeoGeometry | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as GeoGeometry;
    }
  } catch {
    // A malformed polygon means we cannot place the warning; it is dropped.
  }
  return null;
}

function inmetToAlert(a: InmetAviso): Alert | null {
  const event = str(a.descricao);
  if (event === undefined || typeof a.id !== 'number') return null;
  const riscos = (a.riscos ?? []).filter((x) => typeof x === 'string').join('\n');
  // Instruction sentences already end with their own trailing space.
  const instrucoes = (a.instrucoes ?? []).filter((x) => typeof x === 'string').join('');
  const alert: Alert = {
    id: `inmet:${a.id}`,
    event: sanitizeExternalText(event, 200),
    tags: [],
    text: joinOfficialText([str(riscos), str(instrucoes)], event),
    attribution: attributionOf('inmet'),
    url: `https://apiprevmet3.inmet.gov.br/avisos/rss/${a.id}`,
  };
  const severity = str(a.severidade);
  if (severity !== undefined) alert.severity = severity;

  const muni = str(a.municipios);
  const states = str(a.estados);
  if (muni !== undefined || states !== undefined) {
    const list = muni?.split(',') ?? [];
    const shown = list.slice(0, 15).join(',');
    const more = list.length > 15 ? ` … (${list.length} municípios no total)` : '';
    const parts = [
      states !== undefined ? `Estados: ${states}` : undefined,
      muni !== undefined ? `Municípios: ${shown}${more}` : undefined,
    ].filter((x): x is string => x !== undefined);
    alert.areaDescription = sanitizeExternalText(parts.join('. '), 1500);
  }
  // Published as local time without a zone; deliberately not converted.
  const onset = str(a.inicio);
  if (onset !== undefined) alert.onset = onset;
  const expires = str(a.fim);
  if (expires !== undefined) alert.expires = expires;
  return alert;
}

/**
 * INMET publishes `inicio`/`fim` as "YYYY-MM-DD HH:MM" with no zone; they are
 * Brasília time (UTC-3). Parsed explicitly rather than handed to `new Date()`,
 * which would read them in the host's zone and shift the window.
 */
export function parseInmetInstant(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h + 3, mi);
}

/** True when `now` falls inside the published validity window. */
export function inmetInForce(
  aviso: { inicio?: string; fim?: string },
  now: number,
): { inForce: boolean; upcoming: boolean } {
  const start = parseInmetInstant(aviso.inicio);
  const end = parseInmetInstant(aviso.fim);
  if (end !== null && end < now) return { inForce: false, upcoming: false };
  if (start !== null && start > now) return { inForce: false, upcoming: true };
  return { inForce: true, upcoming: false };
}

async function queryInmet(
  http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox },
): Promise<SourceOutcome> {
  let body: InmetResponse;
  try {
    body = await http.json<InmetResponse>(INMET_ACTIVE);
  } catch (err) {
    return { state: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  const alerts: Alert[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  let upcomingCount = 0;
  for (const aviso of [...(body.hoje ?? []), ...(body.futuro ?? [])]) {
    if (aviso.encerrado === true) continue;
    // `encerrado` alone is not vigência: the feed carries tomorrow's warnings
    // in `futuro`, and counting those as in force is a false present-tense
    // warning. Expired ones are dropped; upcoming ones are only counted.
    const { inForce, upcoming } = inmetInForce(aviso, now);
    if (!inForce) {
      if (upcoming) upcomingCount++;
      continue;
    }
    const geom = parsePolygon(aviso.poligono);
    if (geom === null) continue; // no geometry: cannot say the place is inside
    const hit =
      input.lat !== undefined && input.lon !== undefined
        ? geometryContainsPoint(geom, input.lon, input.lat)
        : input.bbox !== undefined && geometryIntersectsBbox(geom, input.bbox);
    if (!hit) continue;
    const alert = inmetToAlert(aviso);
    if (alert === null || seen.has(alert.id)) continue;
    seen.add(alert.id);
    alerts.push(alert);
  }
  return upcomingCount > 0
    ? {
        state: 'ok',
        alerts,
        note: `${upcomingCount} aviso(s) do INMET para este local começam no futuro e NÃO estão incluídos como ativos`,
      }
    : { state: 'ok', alerts };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function validate(input: { lat?: number; lon?: number; bbox?: Bbox }): void {
  const { lat, lon, bbox } = input;
  if ((lat === undefined) !== (lon === undefined)) {
    throw new RangeError('Provide both lat and lon, or a bbox.');
  }
  if (lat !== undefined && lon !== undefined) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      throw new RangeError('lat must be in [-90, 90].');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180)
      throw new RangeError('lon must be in [-180, 180].');
    return;
  }
  if (bbox === undefined) throw new RangeError('Provide lat/lon or a bbox.');
  const [w, s, e, n] = bbox;
  if (
    ![w, s, e, n].every(Number.isFinite) ||
    s < -90 ||
    n > 90 ||
    w < -180 ||
    e > 180 ||
    s > n ||
    w > e
  ) {
    throw new RangeError(
      'bbox must be [west, south, east, north] in degrees with west <= east and south <= north.',
    );
  }
}

/**
 * Active official alerts for a point or a box. If both are given, the point wins.
 *
 * Sources actually queried: NWS (US) and INMET (Brazil). MeteoAlarm (Europe)
 * is deliberately NOT queried: its feeds identify areas by name/EMMA_ID and
 * carry no geometry, so a coordinate cannot be matched to a warning.
 *
 * `severity` filters on each source's own published label (case-insensitive);
 * labels are not mapped between countries.
 */
export async function getAlerts(
  http: HttpClient,
  input: { lat?: number; lon?: number; bbox?: Bbox; severity?: string[] },
): Promise<{ alerts: Alert[]; coverage: string; consulted: ConsultedSource[] }> {
  validate(input);
  const point =
    input.lat !== undefined && input.lon !== undefined
      ? { lat: input.lat, lon: input.lon }
      : undefined;
  const bbox = point === undefined ? input.bbox : undefined;
  const scope = point !== undefined ? 'o ponto' : 'o bbox';

  const nwsRelevant =
    point !== undefined ? nwsMayCover(point.lat, point.lon) : nwsMayCoverBbox(bbox as Bbox);
  const inmetRelevant =
    point !== undefined ? inmetMayCover(point.lat, point.lon) : inmetMayCoverBbox(bbox as Bbox);

  const geo = point !== undefined ? { lat: point.lat, lon: point.lon } : { bbox: bbox as Bbox };
  const [nws, inmet] = await Promise.all([
    nwsRelevant
      ? queryNws(http, {
          ...geo,
          ...(input.severity !== undefined ? { severity: input.severity } : {}),
        })
      : Promise.resolve<SourceOutcome>({ state: 'outside' }),
    inmetRelevant ? queryInmet(http, geo) : Promise.resolve<SourceOutcome>({ state: 'outside' }),
  ]);

  const parts: string[] = [];
  const notCovered: string[] = ['MeteoAlarm (Europa)'];
  const failures: string[] = [];
  let queried = 0;
  let succeeded = 0;

  if (nws.state === 'ok') {
    queried++;
    succeeded++;
    parts.push(
      point !== undefined
        ? 'NWS (EUA) consultado: alertas ativos por polígono/zona oficial para o ponto.'
        : 'NWS (EUA) consultado para o bbox: só alertas com polígono foram casados' +
            (nws.note !== undefined
              ? `; ${nws.note} alerta(s) definidos apenas por zona (sem polígono, p.ex. vigilâncias/watches e avisos marítimos) NÃO puderam ser casados com o bbox e foram omitidos.`
              : '.'),
    );
  } else if (nws.state === 'failed') {
    queried++;
    failures.push(`NWS (EUA): ${nws.reason}`);
    parts.push(
      'NWS (EUA) FALHOU: os alertas dos EUA estão indisponíveis nesta resposta, o que NÃO significa que não existam.',
    );
  } else {
    notCovered.unshift('EUA (NWS; fora da cobertura da API)');
  }

  if (inmet.state === 'ok') {
    queried++;
    succeeded++;
    parts.push(
      'INMET (Brasil) consultado: apenas avisos EM VIGOR agora (os de início futuro são contados, não listados). O INMET define a área oficial por municípios; ' +
        `o casamento com ${scope} usa o polígono publicado, que é um envelope aproximado, e este servidor não resolve em qual município o ponto está. ` +
        'Um aviso listado pode não valer para o local exato; um local fora do polígono não é garantia de ausência de aviso.' +
        (inmet.note !== undefined ? ` ${inmet.note}.` : ''),
    );
  } else if (inmet.state === 'failed') {
    queried++;
    failures.push(`INMET (Brasil): ${inmet.reason}`);
    parts.push(
      'INMET (Brasil) FALHOU: os avisos brasileiros estão indisponíveis nesta resposta, o que NÃO significa que não existam.',
    );
  } else {
    notCovered.unshift('Brasil (INMET)');
  }

  parts.push(
    `Não cobertos por esta consulta: ${notCovered.join('; ')}. ` +
      'O feed do MeteoAlarm responde, mas só identifica áreas por nome/código (sem geometria), então não é possível dizer se um ponto está dentro de um aviso europeu.',
  );

  const wantedSeverity = input.severity?.map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  let alerts = [
    ...(nws.state === 'ok' ? nws.alerts : []),
    ...(inmet.state === 'ok' ? inmet.alerts : []),
  ];
  if (wantedSeverity !== undefined && wantedSeverity.length > 0) {
    alerts = alerts.filter(
      (a) => a.severity !== undefined && wantedSeverity.includes(a.severity.toLowerCase()),
    );
    parts.push(
      'Filtro de severidade aplicado ao rótulo oficial publicado por cada fonte (NWS: Extreme/Severe/Moderate/Minor/Unknown; ' +
        'INMET usa outra escala, Perigo Potencial/Perigo/Grande Perigo, que não é equivalente).',
    );
  }
  parts.push('Ausência de alertas neste resultado não é ausência de risco.');

  if (queried > 0 && succeeded === 0) {
    throw new SourceError(
      `Every official alert source consulted failed (${failures.join(' | ')}).`,
      undefined,
      'Retry shortly, or consult the local weather authority directly. An empty result would have been misleading, so none is returned.',
    );
  }

  alerts.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity?.toLowerCase() ?? ''] ?? 9) -
      (SEVERITY_RANK[b.severity?.toLowerCase() ?? ''] ?? 9),
  );
  const consulted: ConsultedSource[] = [
    toConsulted('nws', nws),
    toConsulted('inmet', inmet),
    // The feed answers but identifies areas by name/code only, with no
    // geometry, so a point can never be matched against a European warning.
    {
      source: 'meteoalarm',
      state: 'outside',
      reason: 'Feed has no geometry; point match impossible.',
    },
  ];
  return { alerts, coverage: parts.join(' '), consulted };
}

function toConsulted(source: ConsultedSource['source'], outcome: SourceOutcome): ConsultedSource {
  if (outcome.state === 'failed') return { source, state: 'failed', reason: outcome.reason };
  return { source, state: outcome.state };
}
