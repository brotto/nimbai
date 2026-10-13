import { z } from 'zod';

/** [west, south, east, north] in degrees, WGS84. */
export const BboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Bbox = z.infer<typeof BboxSchema>;

export const AttributionSchema = z.object({
  /** Catalogue id from `sources.ts`, e.g. `nws`, `open-meteo`. */
  source: z.string(),
  /** The exact credit line the operator must display. */
  text: z.string(),
  /** Licence or terms label, e.g. `public domain`, `CC BY 4.0`. */
  license: z.string(),
  url: z.string().url().optional(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

export const LocationSchema = z.object({
  /** Opaque, stable within a process: `"lat,lon"` rounded to 4 decimals. */
  id: z.string(),
  name: z.string(),
  admin: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().length(2).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  timezone: z.string().optional(),
  population: z.number().int().nonnegative().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

/**
 * An image a model can look at. `thumbnail` is small enough to inline;
 * `url` is the full-resolution original, always returned so clients that
 * cannot render inline images still get something useful.
 */
export const ImageRefSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
  mimeType: z.string(),
  /** Nominal observation time in UTC ISO-8601, when the source states one. */
  validTime: z.string().optional(),
  bbox: BboxSchema.optional(),
  layer: z.string(),
  /** Human-readable description of the colour scale. */
  legend: z.string().optional(),
  /** Typical delay between observation and availability. */
  sourceLatencyMin: z.number().nonnegative().optional(),
  attribution: AttributionSchema,
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  /** Short official event name, e.g. `Tornado Warning`. */
  event: z.string(),
  /** Official severity as published; not normalised across countries. */
  severity: z.string().optional(),
  urgency: z.string().optional(),
  certainty: z.string().optional(),
  /** Impact-based-warning tags (US), e.g. `radar indicated`, `observed`. */
  tags: z.array(z.string()).default([]),
  areaDescription: z.string().optional(),
  onset: z.string().optional(),
  expires: z.string().optional(),
  /** Verbatim official text. Never paraphrase this field. */
  text: z.string(),
  url: z.string().url().optional(),
  attribution: AttributionSchema,
});
export type Alert = z.infer<typeof AlertSchema>;

export const ForecastSeriesSchema = z.object({
  /** Model or office that produced it, e.g. `ECMWF IFS`, `NWS`. */
  model: z.string(),
  /** Model run / issue time, UTC ISO-8601, when published. */
  run: z.string().optional(),
  times: z.array(z.string()),
  variables: z.record(
    z.string(),
    z.object({ unit: z.string(), values: z.array(z.number().nullable()) }),
  ),
  attribution: AttributionSchema,
});
export type ForecastSeries = z.infer<typeof ForecastSeriesSchema>;

/**
 * Severe-weather risk, split into three honestly-labelled kinds. The
 * distinction is a product rule, not a presentation detail: an official
 * warning and a favourable environment must never be reported as the same
 * thing. See `wiki/specs/previsao-tornadica.md`.
 */
export const RiskKind = z.enum([
  /** An authority has issued a warning/watch for this area. */
  'official_warning',
  /** An authority's probabilistic outlook (e.g. SPC Day 1). */
  'official_outlook',
  /** Computed ingredients only. A forecast of potential, never a warning. */
  'favourable_environment',
  /** Automated radar/satellite guidance (e.g. ProbSevere). */
  'automated_guidance',
]);
export type RiskKind = z.infer<typeof RiskKind>;

export const RiskItemSchema = z.object({
  kind: RiskKind,
  label: z.string(),
  detail: z.string().optional(),
  /** 0-1 where the source publishes a probability. */
  probability: z.number().min(0).max(1).optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  url: z.string().url().optional(),
  attribution: AttributionSchema,
});
export type RiskItem = z.infer<typeof RiskItemSchema>;

export const SourceStatusSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  /**
   * Documented typical delay between observation and availability for this
   * source. A published characteristic of the feed, NOT a measurement of the
   * data currently being served.
   */
  typicalLatencyMin: z.number().nonnegative().optional(),
  note: z.string().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/** Every tool result carries the disclaimer and its sources. */
export const SafetyNotice =
  'Not for protection of life or property. Follow your official weather authority ' +
  '(NWS in the US, INMET/Defesa Civil in Brazil, MeteoAlarm in Europe, or your local service).';
