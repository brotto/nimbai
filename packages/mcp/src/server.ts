import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  HttpClient,
  SourceError,
  attributionOf,
  getAlerts,
  getCurrentConditions,
  getForecast,
  getObservedConditions,
  getImageryLoop,
  getLightning,
  getRadarLatest,
  getSatelliteLatest,
  getSevereRisk,
  getSourcesStatus,
  searchLocation,
  type Attribution,
  type Bbox,
  type ConsultedSource,
  type Location,
} from '@nimbai/core';
import { fail, ok, type ToolResult } from './response.js';

export const VERSION = '0.1.0';

/**
 * The NWS API rejects requests that do not identify their caller, so a
 * contact string is mandatory rather than cosmetic. Operators set
 * NWS_USER_AGENT; the fallback keeps `npx` usable out of the box while still
 * identifying the software.
 */
function userAgent(): string {
  const configured = process.env.NWS_USER_AGENT?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : `NimbAI/${VERSION} (+https://github.com/brotto/nimbai)`;
}

const BboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe('[west, south, east, north] in degrees');

const PlaceSchema = z.object({
  lat: z.number().min(-90).max(90).optional().describe('Latitude in degrees'),
  lon: z.number().min(-180).max(180).optional().describe('Longitude in degrees'),
  bbox: BboxSchema.optional(),
});

/** Every tool is a read of public data: nothing it does changes the world. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

type Place = { lat?: number | undefined; lon?: number | undefined; bbox?: Bbox | undefined };

/** A point is needed by most tools; a bbox centre is an acceptable stand-in. */
function requirePoint(input: Place): { lat: number; lon: number } | null {
  if (input.lat !== undefined && input.lon !== undefined) return { lat: input.lat, lon: input.lon };
  if (input.bbox !== undefined) {
    const [w, s, e, n] = input.bbox;
    return { lat: (s + n) / 2, lon: (w + e) / 2 };
  }
  return null;
}

const NEEDS_POINT =
  'Call nimbai_search_location first to turn a place name into lat/lon, or pass a bbox.';

/** Turns any thrown value into a result the model can act on. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceError) {
      return fail(
        err.message,
        err.nextSteps ??
          'The upstream source failed. Call nimbai_get_sources_status to see whether it is down, then retry or tell the user the data is unavailable.',
      );
    }
    return fail(
      err instanceof Error ? err.message : 'Unknown error',
      'Retry once; if it fails again, tell the user NimbAI could not reach the data source.',
    );
  }
}

/**
 * An empty alert list means three different things depending on which sources
 * answered, and saying "no alert found" for all three is a false all-clear.
 * The sentence always names what was actually consulted.
 */
export function alertSummary(count: number, consulted: ConsultedSource[]): string {
  const failed = consulted.filter((c) => c.state === 'failed').map((c) => c.source);
  const answered = consulted.filter((c) => c.state === 'ok').map((c) => c.source);
  if (count > 0) {
    const base = `${count} active official alert(s). Reproduce the official text verbatim, with its source and time.`;
    // A partial list is still a short list: say so, or the user reads it as complete.
    return failed.length > 0
      ? `${base} ${failed.join(', ')} FAILED, so this list may be incomplete.`
      : base;
  }
  if (failed.length > 0) {
    return (
      `No alert from the sources that answered, but ${failed.join(', ')} FAILED — ` +
      'this is NOT an all-clear. Tell the user the source is unavailable and point them at their official authority.'
    );
  }
  if (answered.length === 0) {
    return (
      'No alert source covers this location, so NimbAI cannot say whether a warning is in force. ' +
      'Tell the user to check their national weather service.'
    );
  }
  return `No active official alert from ${answered.join(', ')}. Absence of an alert is not absence of risk.`;
}

function locationLine(l: Location): string {
  return [l.name, l.admin, l.country].filter((p) => p !== undefined && p !== '').join(', ');
}

export interface CreateServerOptions {
  /** Injected in tests so tool calls can be driven without network access. */
  fetch?: typeof globalThis.fetch;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const http = new HttpClient({
    userAgent: userAgent(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const server = new McpServer(
    { name: 'nimbai', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'NimbAI serves weather intelligence from official public sources: forecasts, official ' +
        'alerts (verbatim), satellite and radar imagery, satellite lightning density and ' +
        'severe-weather risk. Start with nimbai_search_location to resolve a place name, then ' +
        'nimbai_get_summary. Always show the attribution returned with every result, state the ' +
        'image time, and never present a favourable environment as an official warning.',
    },
  );

  server.registerTool(
    'nimbai_search_location',
    {
      title: 'Search location',
      description:
        'Resolve a place name (or coordinates) into candidates with lat/lon and timezone. ' +
        'Call this first whenever the user names a place; pass the chosen lat/lon to the other tools.',
      inputSchema: z.object({
        query: z.string().min(1).optional().describe('Place name, e.g. "Foz do Iguaçu"'),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        if (input.query === undefined && (input.lat === undefined || input.lon === undefined)) {
          return fail('Give either `query` or both `lat` and `lon`.', 'Retry with a place name.');
        }
        const candidates = await searchLocation(http, compact(input));
        if (candidates.length === 0) {
          return fail(
            `No location matched ${JSON.stringify(input.query)}.`,
            'Try a shorter name, add the country ("Springfield, Illinois"), or pass lat/lon directly.',
          );
        }
        return ok({
          summary: `${candidates.length} candidate(s); best match ${locationLine(candidates[0]!)}.`,
          data: { candidates },
          attributions: [attributionOf('open-meteo')],
        });
      }),
  );

  server.registerTool(
    'nimbai_get_summary',
    {
      title: 'Weather summary',
      description:
        'Current conditions, the next hours of forecast and any active official alerts for one ' +
        'point. The usual second call after nimbai_search_location. Returns `observed` (a real ' +
        'METAR measurement from the nearest station, with its distance and age) separately from ' +
        '`modelled` (what the model computed for this cell) — tell the user which one you are ' +
        'quoting. Use detail="summary" unless the user asks for depth.',
      inputSchema: PlaceSchema.extend({
        detail: z.enum(['summary', 'standard', 'full']).default('summary'),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const point = requirePoint(input);
        if (point === null) return fail('A point is required.', NEEDS_POINT);

        const hours = input.detail === 'summary' ? 12 : input.detail === 'standard' ? 48 : 120;
        // allSettled, not all: one source failing must not take the whole
        // summary down, least of all the alerts.
        const [currentR, forecastR, alertsR, observedR] = await Promise.allSettled([
          getCurrentConditions(http, point),
          getForecast(http, { ...point, hours }),
          getAlerts(http, point),
          getObservedConditions(http, point),
        ]);
        // Only give up when nothing at all came back. If the weather failed but
        // the alerts resolved, the alerts are the part that matters most.
        if (
          currentR.status === 'rejected' &&
          forecastR.status === 'rejected' &&
          alertsR.status === 'rejected'
        ) {
          throw currentR.reason;
        }

        const observed = observedR.status === 'fulfilled' ? observedR.value : null;
        const obs = observed?.observed ?? null;
        const current = currentR.status === 'fulfilled' ? currentR.value : null;
        const forecast = forecastR.status === 'fulfilled' ? forecastR.value : null;
        const alerts = alertsR.status === 'fulfilled' ? alertsR.value : null;

        const attributions: Attribution[] = [];
        if (current !== null) attributions.push(current.attribution);
        if (forecast !== null) attributions.push(forecast.attribution);
        if (alerts !== null) attributions.push(...alerts.alerts.map((a) => a.attribution));
        if (obs !== null) attributions.push(obs.attribution);

        const unavailable: string[] = [];
        if (current === null) unavailable.push('model current conditions');
        if (obs === null) unavailable.push('surface observation (METAR)');
        if (forecast === null) unavailable.push('forecast');
        if (alerts === null) unavailable.push('official alerts');

        const conditionLine =
          obs !== null
            ? `Observed ${obs.temperatureC ?? '?'}°C at ${obs.station.id}, ${obs.distanceKm} km away, ${obs.ageMin} min ago.`
            : current === null
              ? 'Current conditions unavailable.'
              : `${current.weatherText}, ${current.temperatureC ?? '?'}°C (model analysis, not a measurement).`;
        const alertLine =
          alerts === null
            ? 'Official alerts could NOT be checked — this is not an all-clear.'
            : alerts.alerts.length > 0
              ? `${alerts.alerts.length} active official alert(s): ${alerts.alerts.map((a) => a.event).join(', ')}.`
              : alertSummary(0, alerts.consulted);

        return ok({
          summary: `${conditionLine} ${alertLine}`,
          data: {
            // Kept apart on purpose: `observed` is what an instrument
            // measured at a station some distance away; `modelled` is what a
            // model computed for this grid cell. Reporting the second as the
            // first is the kind of quiet dishonesty this project exists to avoid.
            observed: obs,
            observed_coverage: observed?.coverage ?? 'Surface observation lookup failed.',
            modelled: current,
            forecast:
              forecast === null
                ? null
                : input.detail === 'summary'
                  ? trimSeries(forecast, 12)
                  : forecast,
            alerts: alerts?.alerts ?? null,
            alerts_coverage: alerts?.coverage ?? null,
            alerts_consulted: alerts?.consulted ?? null,
            unavailable,
            ...(input.bbox !== undefined && input.lat === undefined
              ? { note: 'A bbox was given; its centre was used as the point for this summary.' }
              : {}),
          },
          attributions,
          safetyNotice: true,
        });
      }),
  );

  server.registerTool(
    'nimbai_get_forecast',
    {
      title: 'Forecast series',
      description:
        'Hourly forecast series (temperature, precipitation, wind, cloud, CAPE) for one point. ' +
        'Use when the user asks about specific hours or variables. The source names the model; it ' +
        'does not always publish a run time, so `run` may be absent — do not invent one.',
      inputSchema: PlaceSchema.extend({
        hours: z.number().int().min(1).max(384).optional(),
        days: z.number().int().min(1).max(16).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const point = requirePoint(input);
        if (point === null) return fail('A point is required.', NEEDS_POINT);
        const series = await getForecast(http, { ...point, ...numeric(input, ['hours', 'days']) });
        return ok({
          summary: `${series.model} forecast, ${series.times.length} hourly steps, ${Object.keys(series.variables).length} variables.`,
          data: { forecast: series },
          attributions: [series.attribution],
        });
      }),
  );

  server.registerTool(
    'nimbai_get_alerts',
    {
      title: 'Official alerts',
      description:
        'Active official warnings and watches for a point or bbox, with the issuing authority’s ' +
        'text reproduced verbatim. Reproduce that text to the user without paraphrasing it, and ' +
        'read `coverage` — it says which countries this call actually checked.',
      inputSchema: PlaceSchema.extend({
        severity: z.array(z.string()).optional().describe('Filter by official severity labels'),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        // A bbox must be queried as a bbox: deriving its centre would shrink
        // the query to one point and silently drop alerts elsewhere in it.
        const geo =
          input.bbox !== undefined
            ? { bbox: input.bbox }
            : input.lat !== undefined && input.lon !== undefined
              ? { lat: input.lat, lon: input.lon }
              : null;
        if (geo === null) return fail('A point or bbox is required.', NEEDS_POINT);

        const result = await getAlerts(http, {
          ...geo,
          ...(input.severity === undefined ? {} : { severity: input.severity }),
        });
        return ok({
          summary: alertSummary(result.alerts.length, result.consulted),
          data: { alerts: result.alerts, coverage: result.coverage, consulted: result.consulted },
          attributions: result.alerts.map((a) => a.attribution),
          safetyNotice: true,
        });
      }),
  );

  server.registerTool(
    'nimbai_get_satellite_latest',
    {
      title: 'Latest satellite image',
      description:
        'Newest satellite image covering a point or bbox (GeoColor, infrared or water vapour). ' +
        'Returns a URL and a legend. These "latest" feeds carry no machine-readable timestamp, so ' +
        '`validTime` is usually absent: use `sourceLatencyMin` to say how stale it typically is, ' +
        'and never state an observation time the result does not contain.',
      inputSchema: PlaceSchema.extend({
        product: z.enum(['geocolor', 'ir', 'wv', 'visible']).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const result = await getSatelliteLatest(http, compact(input));
        return ok({
          summary: `${result.satellite} ${result.image.layer}${result.image.validTime === undefined ? '' : ` valid ${result.image.validTime}`}.`,
          data: result,
          attributions: [result.image.attribution],
        });
      }),
  );

  server.registerTool(
    'nimbai_get_radar_latest',
    {
      title: 'Latest radar image',
      description:
        'Newest weather-radar image for a point or bbox, plus the radar sites covering it. ' +
        'Radar coverage is national, not global: read `gaps` before telling the user anything.',
      inputSchema: PlaceSchema,
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const result = await getRadarLatest(http, compact(input));
        return ok({
          summary: `Radar ${result.image.layer}; ${result.sites.length} site(s) in range. ${result.coverage}`,
          data: result,
          attributions: [result.image.attribution],
        });
      }),
  );

  server.registerTool(
    'nimbai_get_lightning',
    {
      title: 'Lightning activity',
      description:
        'Satellite-detected lightning activity near a point, as gridded flash density imagery. ' +
        'These are optical satellite detections aggregated on a grid, not individual ' +
        'cloud-to-ground strikes, and must never be presented as a lightning-safety service.',
      inputSchema: PlaceSchema.extend({
        minutes: z.number().int().min(5).max(1440).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const result = await getLightning(http, compact(input));
        return ok({
          summary:
            result.image === null
              ? `No lightning imagery available for this point. ${result.coverage}`
              : `Lightning flash density imagery. ${result.caveat}`,
          data: result,
          attributions: result.image === null ? [] : [result.image.attribution],
          safetyNotice: true,
        });
      }),
  );

  server.registerTool(
    'nimbai_get_imagery_loop',
    {
      title: 'Imagery loop',
      description:
        'A chronological list of image frames for satellite or radar, for showing how a system ' +
        'moved. Returns frame URLs, oldest first, not a video; at most 24 frames. Satellite frames ' +
        'carry a real `validTime`; radar frames come from a positional feed and do not.',
      inputSchema: PlaceSchema.extend({
        layer: z.enum(['satellite', 'radar']),
        frames: z.number().int().min(2).max(24).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const result = await getImageryLoop(http, { layer: input.layer, ...compact(input) });
        if (result.frames.length === 0) {
          return fail(
            `No frames available for layer ${input.layer} at this location.`,
            'Try the other layer, or call nimbai_get_satellite_latest for a single current image.',
          );
        }
        return ok({
          summary: `${result.frames.length} ${input.layer} frames, oldest first.`,
          data: result,
          attributions: result.frames.map((f) => f.attribution),
        });
      }),
  );

  server.registerTool(
    'nimbai_get_severe_risk',
    {
      title: 'Severe weather risk',
      description:
        'Severe-weather risk for a point, split by kind: official_warning, official_outlook, ' +
        'favourable_environment and automated_guidance. These are NOT interchangeable — an ' +
        'environment favourable to tornadoes is a forecast of potential, never a warning. ' +
        'Always read `gaps`: it says what does not exist for that location.',
      inputSchema: PlaceSchema,
      annotations: READ_ONLY,
    },
    async (input) =>
      guard(async () => {
        const point = requirePoint(input);
        if (point === null) return fail('A point is required.', NEEDS_POINT);
        const result = await getSevereRisk(http, point);
        const warnings = result.items.filter((i) => i.kind === 'official_warning');
        const others = result.items.length - warnings.length;
        const summary =
          warnings.length > 0
            ? `${warnings.length} official warning(s) in force. Lead with them and cite the authority.`
            : result.warnings === 'failed'
              ? `The official-warning lookup FAILED, so NimbAI cannot say whether a warning is in force — this is NOT an all-clear. ${others} other risk signal(s); read gaps.`
              : result.warnings === 'outside'
                ? `No warning source covers this point, so NimbAI cannot say whether a warning is in force. ${others} other risk signal(s); read gaps.`
                : `No official warning in force per the sources that answered. ${others} other risk signal(s). Absence of a warning is not absence of risk.`;
        return ok({
          summary,
          data: {
            ...result,
            ...(input.bbox !== undefined && input.lat === undefined
              ? { note: 'A bbox was given; its centre was used as the point.' }
              : {}),
          },
          attributions: result.items.map((i) => i.attribution),
          safetyNotice: true,
        });
      }),
  );

  server.registerTool(
    'nimbai_get_sources_status',
    {
      title: 'Source status',
      description:
        'Reachability and typical latency of each upstream data source. Call this when an image ' +
        'or dataset looks stale or a tool failed, so you can tell the user why.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const result = await getSourcesStatus(http);
        const down = result.statuses.filter((s) => !s.ok);
        return ok({
          summary:
            down.length === 0
              ? `All ${result.statuses.length} probed sources reachable.`
              : `${down.length} of ${result.statuses.length} sources unreachable: ${down.map((d) => d.source).join(', ')}.`,
          data: result,
          attributions: [],
        });
      }),
  );

  return server;
}

/** Keeps only the first `n` steps of a series, for the cheap `summary` detail level. */
function trimSeries<
  T extends {
    times: string[];
    variables: Record<string, { unit: string; values: (number | null)[] }>;
  },
>(series: T, n: number): T {
  const variables: Record<string, { unit: string; values: (number | null)[] }> = {};
  for (const [key, v] of Object.entries(series.variables)) {
    variables[key] = { unit: v.unit, values: v.values.slice(0, n) };
  }
  return { ...series, times: series.times.slice(0, n), variables };
}

/**
 * Zod infers an optional field as `T | undefined`, which
 * `exactOptionalPropertyTypes` refuses to pass to an adapter declared `T?`.
 * Dropping the undefined-valued keys makes the object assignable, and the
 * return type says so.
 */
type Compacted<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function compact<T extends Record<string, unknown>>(obj: T): Compacted<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Compacted<T>;
}

/** Copies only the defined numeric keys, so exactOptionalPropertyTypes stays happy. */
function numeric<K extends string>(
  input: Partial<Record<K, number | undefined>>,
  keys: K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const v = input[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
