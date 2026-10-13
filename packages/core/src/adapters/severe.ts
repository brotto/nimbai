import { attributionOf } from '../sources.js';
import type { HttpClient } from '../http.js';
import { SourceError, sanitizeExternalText } from '../http.js';
import type { Alert, RiskItem } from '../types.js';
import { geometryContainsPoint, getAlerts } from './alerts.js';
import type { GeoGeometry } from './alerts.js';

const SPC_BASE = 'https://www.spc.noaa.gov/products/outlook';

type SpcHazard = 'cat' | 'torn' | 'hail' | 'wind' | 'prob';

interface SpcProduct {
  day: 1 | 2 | 3;
  hazard: SpcHazard;
}

/**
 * Paths verified with curl (HTTP 200, application/geo+json). Day 3 publishes
 * no per-hazard files (`day3otlk_torn` etc. are 404); only categorical and
 * the combined "any severe" probability exist.
 */
const SPC_PRODUCTS: SpcProduct[] = [
  { day: 1, hazard: 'cat' },
  { day: 1, hazard: 'torn' },
  { day: 1, hazard: 'hail' },
  { day: 1, hazard: 'wind' },
  { day: 2, hazard: 'cat' },
  { day: 2, hazard: 'torn' },
  { day: 2, hazard: 'hail' },
  { day: 2, hazard: 'wind' },
  { day: 3, hazard: 'cat' },
  { day: 3, hazard: 'prob' },
];

const HAZARD_TITLE: Record<SpcHazard, string> = {
  cat: 'categorical outlook',
  torn: 'tornado probability',
  hail: 'hail probability',
  wind: 'damaging wind probability',
  prob: 'any-severe probability',
};

const HAZARD_NOUN: Record<Exclude<SpcHazard, 'cat'>, string> = {
  torn: 'a tornado',
  hail: 'severe hail (1 in or larger)',
  wind: 'damaging wind (58 mph or greater)',
  prob: 'severe weather (tornado, hail or damaging wind)',
};

interface SpcFeature {
  geometry?: GeoGeometry | null;
  properties?: {
    DN?: number;
    LABEL?: string;
    LABEL2?: string;
    VALID_ISO?: string;
    EXPIRE_ISO?: string;
    ISSUE_ISO?: string;
    FORECASTER?: string;
  };
}

interface SpcCollection {
  features?: SpcFeature[];
}

/** Convective events issued by the NWS that belong in a severe-weather answer. */
const NWS_CONVECTIVE_EVENTS = new Set([
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Extreme Wind Warning',
]);

/** INMET storm warnings (wind, hail). Floods, heat, humidity etc. are out of scope. */
const INMET_CONVECTIVE = /tempestade|granizo|vendaval/i;

/** Contiguous US with a small margin; SPC outlooks exist only for this domain. */
function inConus(lat: number, lon: number): boolean {
  return lat >= 24.4 && lat <= 49.6 && lon >= -125 && lon <= -66.9;
}

function inBrazilRegion(lat: number, lon: number): boolean {
  return lat >= -35 && lat <= 6 && lon >= -75 && lon <= -33;
}

function inNwsRegion(lat: number, lon: number): boolean {
  return (
    (lat >= 10 && lat <= 72 && (lon <= -60 || lon >= 144)) ||
    (lat >= -15 && lat <= -10 && lon <= -165)
  );
}

async function fetchSpcItem(
  http: HttpClient,
  p: SpcProduct,
  lat: number,
  lon: number,
  nowMs: number,
): Promise<RiskItem | null> {
  const name = `day${p.day}otlk_${p.hazard}`;
  // One call fans out to every SPC product; the default 2 retries would turn
  // that into up to 30 requests to a public NOAA host for a single tool call.
  // A missing outlook is already tolerated per-product, so one try is enough.
  const body = await http.json<SpcCollection>(`${SPC_BASE}/${name}.nolyr.geojson`, {
    retries: 0,
  });

  // Files are `nolyr`: polygons carry holes, so test every feature and keep the highest.
  let best: { rank: number; feature: SpcFeature } | undefined;
  for (const feature of body.features ?? []) {
    const props = feature.properties;
    if (props === undefined || !geometryContainsPoint(feature.geometry, lon, lat)) continue;
    const rank = p.hazard === 'cat' ? (props.DN ?? 0) : Number.parseFloat(props.LABEL ?? '');
    if (!Number.isFinite(rank)) continue; // e.g. hatching or "Less Than 2%" placeholders
    if (best === undefined || rank > best.rank) best = { rank, feature };
  }
  if (best === undefined) return null;

  const props = best.feature.properties;
  if (props === undefined) return null;
  const expireMs = props.EXPIRE_ISO !== undefined ? Date.parse(props.EXPIRE_ISO) : Number.NaN;
  if (Number.isFinite(expireMs) && expireMs <= nowMs) return null; // stale file, outlook has lapsed

  const issued = props.ISSUE_ISO !== undefined ? ` Issued ${props.ISSUE_ISO}` : '';
  const by =
    props.FORECASTER !== undefined ? ` by ${sanitizeExternalText(props.FORECASTER, 80)}` : '';
  const item: RiskItem = {
    kind: 'official_outlook',
    label: '',
    attribution: attributionOf('spc'),
    url: `https://www.spc.noaa.gov/products/outlook/day${p.day}otlk.html`,
  };

  if (p.hazard === 'cat') {
    const risk = sanitizeExternalText(props.LABEL2 ?? props.LABEL ?? 'risk area', 80);
    item.label = `SPC Day ${p.day} ${HAZARD_TITLE.cat}: ${risk}`;
    // The lowest category (TSTM) is ordinary thunderstorms, not a severe-risk
    // area. Describing it as "severe storms are possible" overstates it.
    const generalOnly = /general\s+thunder/i.test(risk) || /\bTSTM\b/i.test(risk);
    item.detail = generalOnly
      ? `SPC categorical convective outlook covering this point.${issued}${by}. ` +
        'This is the lowest category: ordinary (non-severe) thunderstorms are possible. ' +
        'It is NOT a severe-weather risk area and NOT a warning.'
      : `SPC categorical convective outlook covering this point.${issued}${by}. ` +
        'This is a forecast of where severe storms are possible, not a warning.';
  } else {
    const pct = Math.round(best.rank * 100);
    item.label = `SPC Day ${p.day} ${HAZARD_TITLE[p.hazard]}: ${pct}%`;
    item.probability = Math.min(Math.max(best.rank, 0), 1);
    item.detail =
      `SPC probability of ${HAZARD_NOUN[p.hazard]} within 25 miles (40 km) of this point.${issued}${by}. ` +
      'This is a forecast outlook, not a warning.';
  }
  if (props.VALID_ISO !== undefined) item.validFrom = props.VALID_ISO;
  if (props.EXPIRE_ISO !== undefined) item.validTo = props.EXPIRE_ISO;
  return item;
}

function alertToRisk(alert: Alert): RiskItem {
  const label = alert.tags.length > 0 ? `${alert.event} (${alert.tags.join(', ')})` : alert.event;
  const item: RiskItem = {
    kind: 'official_warning',
    label,
    // The official text, unaltered.
    detail: alert.text,
    attribution: alert.attribution,
  };
  if (alert.onset !== undefined) item.validFrom = alert.onset;
  if (alert.expires !== undefined) item.validTo = alert.expires;
  if (alert.url !== undefined) item.url = alert.url;
  return item;
}

function isConvective(alert: Alert): boolean {
  return alert.attribution.source === 'inmet'
    ? INMET_CONVECTIVE.test(alert.event)
    : NWS_CONVECTIVE_EVENTS.has(alert.event);
}

/**
 * Severe-weather risk for a point, as three honestly separated layers:
 * official warnings (`official_warning`, NWS/INMET) and SPC outlooks
 * (`official_outlook`). Computed favourable environments
 * (`favourable_environment`) and automated guidance (`automated_guidance`)
 * are not produced in this phase and are listed in `gaps`.
 *
 * An empty `items` list never means "no risk": read `coverage` and `gaps`.
 */
export async function getSevereRisk(
  http: HttpClient,
  input: { lat: number; lon: number },
): Promise<{
  items: RiskItem[];
  coverage: string;
  gaps: string[];
  /** Whether the official-warning lookup actually answered. */
  warnings: 'ok' | 'failed' | 'outside';
}> {
  const { lat, lon } = input;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    throw new RangeError('lat must be in [-90, 90].');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180)
    throw new RangeError('lon must be in [-180, 180].');

  const nowMs = Date.now();
  const items: RiskItem[] = [];
  const gaps: string[] = [];
  const parts: string[] = [];
  let attempted = 0;
  let succeeded = 0;
  const errors: string[] = [];

  // Official warnings/watches.
  const warningsRelevant = inNwsRegion(lat, lon) || inBrazilRegion(lat, lon);
  const outlooksRelevant = inConus(lat, lon);

  const [warnRes, spcRes] = await Promise.all([
    warningsRelevant
      ? getAlerts(http, { lat, lon }).then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, e }),
        )
      : Promise.resolve(undefined),
    outlooksRelevant
      ? Promise.allSettled(SPC_PRODUCTS.map((p) => fetchSpcItem(http, p, lat, lon, nowMs)))
      : Promise.resolve(undefined),
  ]);

  if (warnRes !== undefined) {
    attempted++;
    if (warnRes.ok) {
      succeeded++;
      const convective = warnRes.r.alerts.filter(isConvective);
      items.push(...convective.map(alertToRisk));
      parts.push(
        `Avisos oficiais (convectivos: tornado, tempestade severa, vento extremo; INMET tempestade/granizo): ${warnRes.r.coverage}`,
      );
      if (warnRes.r.alerts.some((a) => a.attribution.source === 'inmet')) {
        gaps.push(
          'Avisos do INMET são casados por polígono aproximado; a área oficial é por município e o município do ponto não foi resolvido.',
        );
      }
    } else {
      const msg = warnRes.e instanceof Error ? warnRes.e.message : String(warnRes.e);
      errors.push(`avisos oficiais: ${msg}`);
      parts.push(
        'Avisos oficiais FALHARAM ao ser consultados: isso NÃO significa que não haja aviso vigente. Consulte a autoridade meteorológica local.',
      );
      gaps.push('Avisos oficiais (NWS/INMET) indisponíveis nesta resposta por erro na fonte.');
    }
  } else {
    parts.push(
      'Avisos oficiais: nenhuma fonte de aviso integrada cobre este ponto (NWS cobre os EUA; INMET, o Brasil).',
    );
  }

  if (spcRes !== undefined) {
    attempted++;
    const failed: string[] = [];
    spcRes.forEach((res, i) => {
      const p = SPC_PRODUCTS[i];
      if (p === undefined) return;
      if (res.status === 'fulfilled') {
        if (res.value !== null) items.push(res.value);
      } else {
        const why =
          res.reason instanceof SourceError && res.reason.status !== undefined
            ? `HTTP ${res.reason.status}`
            : 'erro';
        failed.push(`Day ${p.day} ${HAZARD_TITLE[p.hazard]} (${why})`);
      }
    });
    if (failed.length < SPC_PRODUCTS.length) succeeded++;
    else errors.push('SPC: todos os produtos falharam');
    if (failed.length > 0) {
      gaps.push(`Produtos do SPC indisponíveis nesta resposta: ${failed.join('; ')}.`);
    }
    parts.push(
      'SPC Convective Outlook Dias 1 a 3 consultado (categórico e probabilidades de tornado/granizo/vento nos dias 1-2; probabilidade geral no dia 3). ' +
        'Só aparecem áreas de risco do SPC que contêm o ponto; se não há item do SPC, nenhuma área de risco o cobre (ou o produto não estava vigente).',
    );
    gaps.push(
      'SPC Dias 4-8 e as áreas hachuradas de severidade significativa não foram incluídos.',
    );
  } else {
    parts.push(
      'SPC Convective Outlook não consultado: cobre apenas os EUA contíguos e este ponto está fora desse domínio.',
    );
  }

  // Honest, structural gaps.
  if (inBrazilRegion(lat, lon)) {
    gaps.push('Não existe aviso oficial de tornado por polígono no Brasil.');
  }
  if (!warningsRelevant) {
    gaps.push(
      'Para este ponto nenhum aviso ou outlook oficial de tempo severo é consultado por este servidor. ' +
        'O MeteoAlarm (Europa) não é usado porque seus feeds não trazem geometria, então um ponto não pode ser casado com um aviso.',
    );
  } else if (!outlooksRelevant && !inBrazilRegion(lat, lon)) {
    gaps.push(
      'Não há outlook probabilístico oficial integrado para este ponto (o do SPC cobre só os EUA contíguos).',
    );
  }
  gaps.push(
    'A camada de ambiente favorável (STP/SCP e índices de cisalhamento/instabilidade) ainda não existe: chega numa fase futura. Nenhum item de ambiente favorável é emitido.',
  );
  gaps.push(
    'ProbSevere (guidance automatizada por radar) e MRMS não estão integrados: chegam numa fase futura.',
  );

  parts.push('Ausência de aviso ou de outlook não é ausência de risco.');

  if (attempted > 0 && succeeded === 0) {
    throw new SourceError(
      `Every severe-weather source consulted failed (${errors.join(' | ')}).`,
      undefined,
      'Retry shortly, or consult the local weather authority directly. An empty result would have been misleading, so none is returned.',
    );
  }

  // `warnRes.ok` only means the lookup returned without throwing: every source
  // inside it may still have been out of coverage (a point in Mexico sits
  // inside the NWS nominal box, gets a 400, and comes back `outside`). Deriving
  // 'ok' from that would claim "no warning per the sources that answered" when
  // none answered.
  const warnings: 'ok' | 'failed' | 'outside' =
    warnRes === undefined
      ? 'outside'
      : !warnRes.ok
        ? 'failed'
        : warnRes.r.consulted.some((c) => c.state === 'ok')
          ? 'ok'
          : warnRes.r.consulted.some((c) => c.state === 'failed')
            ? 'failed'
            : 'outside';
  return { items, coverage: parts.join(' '), gaps, warnings };
}
