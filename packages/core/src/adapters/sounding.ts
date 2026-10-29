import { attributionOf } from '../sources.js';
import { SourceError, type HttpClient } from '../http.js';
import type { Attribution } from '../types.js';
import {
  bulkShear,
  dewPointFromRh,
  bunkersStormMotion,
  cyclonicMover,
  hemisphereOf,
  lapseRateCPerKm,
  liftParcel,
  meanWind,
  mixedLayerParcel,
  precipitableWaterMm,
  pressureAtHeight,
  stormRelativeHelicity,
  windComponents,
  windFromComponents,
  type EnvLevel,
  type Hemisphere,
  type ParcelPoint,
  type ParcelResult,
  type Wind,
  type WindLevel,
} from '../thermo.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** Every pressure level Open-Meteo publishes, highest pressure first. */
export const PRESSURE_LEVELS_HPA = [
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30,
] as const;

const LEVEL_VARS = [
  'temperature',
  'dew_point',
  'relative_humidity',
  'geopotential_height',
  'wind_speed',
  'wind_direction',
] as const;

const SURFACE_VARS = [
  'surface_pressure',
  'temperature_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'cape',
  'convective_inhibition',
  'lifted_index',
  'freezing_level_height',
] as const;

/** How far ahead a sounding may be requested, hours. */
const MAX_HOURS_AHEAD = 120;
/** Anemometer height the surface wind is reported at. */
const SURFACE_WIND_HEIGHT_M = 10;

export interface SoundingLevel {
  pressureHpa: number;
  /** Geopotential height, m above mean sea level. */
  heightM: number;
  /** Height above the model's ground elevation, m. */
  heightAglM: number;
  temperatureC: number;
  dewPointC: number | null;
  relativeHumidityPct: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
}

export interface SoundingParcel {
  /** Which parcel was lifted: the surface one, or the mixed lowest 100 hPa. */
  label: 'surface' | 'mixed_layer_100hPa';
  startPressureHpa: number;
  startTemperatureC: number;
  startDewPointC: number;
  capeJkg: number;
  /**
   * NEGATIVE by convention here: the work the parcel must be given to reach
   * its LFC. Open-Meteo reports its own CIN as a positive magnitude in
   * `model.convectiveInhibitionJkg` — the two have opposite signs.
   */
  cinJkg: number | null;
  /** The parcel was still buoyant at the profile top: `capeJkg` is a lower bound. */
  capeTruncated: boolean;
  lclPressureHpa: number;
  lclHeightAglM: number | null;
  lfcPressureHpa: number | null;
  lfcHeightAglM: number | null;
  elPressureHpa: number | null;
  elHeightAglM: number | null;
  /**
   * The parcel's own temperature at each reported pressure level. Plotted
   * against the environment temperature, this is the parcel curve of a
   * Skew-T; the area between the two curves is the CAPE above.
   */
  curve: { pressureHpa: number; temperatureC: number }[];
}

export interface LayerWind {
  speedMs: number;
  directionDeg: number;
  u: number;
  v: number;
}

export interface SoundingKinematics {
  hemisphere: Hemisphere;
  /** The Bunkers member that rotates cyclonically here. */
  cyclonicMover: 'right' | 'left';
  meanWind0to6km: LayerWind | null;
  bunkersRight: LayerWind | null;
  bunkersLeft: LayerWind | null;
  bulkShear0to1kmMs: number | null;
  bulkShear0to3kmMs: number | null;
  bulkShear0to6kmMs: number | null;
  /**
   * SRH relative to the cyclonic mover, sign-corrected so that a positive
   * number means "favourable for a cyclonic supercell" in either hemisphere.
   */
  srh0to1kmM2S2: number | null;
  srh0to3kmM2S2: number | null;
  /** The same quantities before the Southern-Hemisphere sign flip. */
  srh0to1kmRawM2S2: number | null;
  srh0to3kmRawM2S2: number | null;
  signConvention: string;
}

export interface SoundingThermodynamics {
  precipitableWaterMm: number | null;
  lapseRate0to3kmCPerKm: number | null;
  lapseRate700to500hPaCPerKm: number | null;
  surfaceParcel: SoundingParcel | null;
  mixedLayerParcel: SoundingParcel | null;
}

/** Diagnostics the model itself published, kept apart from anything NimbAI computed. */
export interface ModelDiagnostics {
  capeJkg: number | null;
  /** POSITIVE magnitude, as Open-Meteo publishes it — opposite in sign to `SoundingParcel.cinJkg`. */
  convectiveInhibitionJkg: number | null;
  liftedIndex: number | null;
  freezingLevelHeightM: number | null;
}

export interface Sounding {
  validTime: string;
  lat: number;
  lon: number;
  elevationM: number;
  surfacePressureHpa: number;
  surfaceTemperatureC: number;
  surfaceDewPointC: number;
  levels: SoundingLevel[];
  thermodynamics: SoundingThermodynamics;
  kinematics: SoundingKinematics;
  model: ModelDiagnostics;
  coverage: string;
  gaps: string[];
  attribution: Attribution;
}

interface OpenMeteoSounding {
  elevation?: number;
  hourly?: Record<string, unknown> & { time?: string[] };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function first(body: OpenMeteoSounding, key: string): number | null {
  const series = body.hourly?.[key];
  return Array.isArray(series) ? num(series[0]) : null;
}

/** Open-Meteo returns UTC times without a zone designator when timezone=UTC. */
function toUtcIso(t: string): string {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(t) ? t : `${t}${t.length === 16 ? ':00' : ''}Z`;
}

function hourStamp(hoursAhead: number): string {
  const d = new Date(Date.now() + hoursAhead * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13).concat(':00');
}

function layerWind(wind: Wind | null): LayerWind | null {
  if (wind === null) return null;
  const { speedMs, directionDeg } = windFromComponents(wind);
  return { speedMs, directionDeg, u: wind.u, v: wind.v };
}

/** Parcel temperature at one pressure, interpolated along the ascent in ln p. */
function curveAt(path: readonly ParcelPoint[], pressureHpa: number): number | null {
  for (let i = 1; i < path.length; i++) {
    const lower = path[i - 1] as ParcelPoint;
    const upper = path[i] as ParcelPoint;
    if (pressureHpa <= lower.pressureHpa && pressureHpa >= upper.pressureHpa) {
      const span = Math.log(upper.pressureHpa / lower.pressureHpa);
      if (span === 0) return lower.temperatureC;
      const f = Math.log(pressureHpa / lower.pressureHpa) / span;
      return lower.temperatureC + f * (upper.temperatureC - lower.temperatureC);
    }
  }
  return null;
}

function toSoundingParcel(
  label: SoundingParcel['label'],
  start: { pressureHpa: number; temperatureC: number; dewPointC: number },
  result: ParcelResult,
  elevationM: number,
  levels: readonly SoundingLevel[],
): SoundingParcel {
  const agl = (m: number | null): number | null => (m === null ? null : m - elevationM);
  const curve: SoundingParcel['curve'] = [];
  for (const level of levels) {
    const temperatureC = curveAt(result.path, level.pressureHpa);
    if (temperatureC !== null) curve.push({ pressureHpa: level.pressureHpa, temperatureC });
  }
  return {
    label,
    startPressureHpa: start.pressureHpa,
    startTemperatureC: start.temperatureC,
    startDewPointC: start.dewPointC,
    capeJkg: result.capeJkg,
    cinJkg: result.cinJkg,
    capeTruncated: result.capeTruncated,
    lclPressureHpa: result.lcl.pressureHpa,
    lclHeightAglM: agl(result.lclHeightM),
    lfcPressureHpa: result.lfcPressureHpa,
    lfcHeightAglM: agl(result.lfcHeightM),
    elPressureHpa: result.elPressureHpa,
    elHeightAglM: agl(result.elHeightM),
    curve,
  };
}

/**
 * Vertical profile for one point and hour, plus the parameters derived from
 * it: a Skew-T sounding in numbers rather than as a plot.
 *
 * Two classes of number come back and they are kept in separate objects on
 * purpose. `model` holds what the forecast model published for this cell.
 * `thermodynamics` and `kinematics` hold what NimbAI computed from the 19
 * reported levels. They will not agree exactly, and neither is a correction
 * of the other: the model ran at its own vertical resolution with its own
 * parcel definition, while this profile is a coarse sample of it.
 */
export async function getSounding(
  http: HttpClient,
  input: { lat: number; lon: number; hoursAhead?: number },
): Promise<Sounding> {
  const { lat, lon } = input;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError('lat must be -90..90 and lon -180..180');
  }
  const hoursAhead = Math.min(Math.max(Math.trunc(input.hoursAhead ?? 0), 0), MAX_HOURS_AHEAD);
  const stamp = hourStamp(hoursAhead);

  const hourly = [
    ...SURFACE_VARS,
    ...PRESSURE_LEVELS_HPA.flatMap((level) => LEVEL_VARS.map((v) => `${v}_${level}hPa`)),
  ].join(',');

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly,
    start_hour: stamp,
    end_hour: stamp,
    timezone: 'UTC',
    temperature_unit: 'celsius',
    wind_speed_unit: 'ms',
  });

  const body = await http.json<OpenMeteoSounding>(`${ENDPOINT}?${params.toString()}`);
  const times = body.hourly?.time;
  const time = Array.isArray(times) ? times[0] : undefined;
  // Shape-checked, not merely typeof-checked: this string is interpolated
  // into prose the model reads back, and `toUtcIso` assumes its length.
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    throw new SourceError(
      'Open-Meteo returned no hour for this sounding.',
      undefined,
      'Retry with a smaller hours_ahead, or treat the sounding as unavailable for this point.',
    );
  }

  const elevationM = num(body.elevation) ?? 0;
  const surfacePressure = first(body, 'surface_pressure');
  const surfaceT = first(body, 'temperature_2m');
  const surfaceTd = first(body, 'dew_point_2m');
  if (surfacePressure === null || surfaceT === null || surfaceTd === null) {
    throw new SourceError(
      'Open-Meteo returned no surface temperature, dew point or pressure, so no parcel can be lifted.',
      undefined,
      'Treat the sounding as unavailable for this point; do not report the pressure levels alone as a sounding.',
    );
  }

  const levels: SoundingLevel[] = [];
  for (const level of PRESSURE_LEVELS_HPA) {
    // Levels at a higher pressure than the ground are below it: the model
    // extrapolates them and they are not part of the atmosphere here.
    if (level >= surfacePressure) continue;
    const temperatureC = first(body, `temperature_${level}hPa`);
    const heightM = first(body, `geopotential_height_${level}hPa`);
    if (temperatureC === null || heightM === null) continue;
    levels.push({
      pressureHpa: level,
      heightM,
      heightAglM: heightM - elevationM,
      temperatureC,
      dewPointC: first(body, `dew_point_${level}hPa`),
      relativeHumidityPct: first(body, `relative_humidity_${level}hPa`),
      windSpeedMs: first(body, `wind_speed_${level}hPa`),
      windDirectionDeg: first(body, `wind_direction_${level}hPa`),
    });
  }

  const model: ModelDiagnostics = {
    capeJkg: first(body, 'cape'),
    convectiveInhibitionJkg: first(body, 'convective_inhibition'),
    liftedIndex: first(body, 'lifted_index'),
    freezingLevelHeightM: first(body, 'freezing_level_height'),
  };

  const attribution = attributionOf('open-meteo');
  const hemisphere = hemisphereOf(lat);
  const gaps: string[] = [];

  // Thermodynamic profile: surface first, then every level with both a
  // temperature and a dew point. A level missing its dew point (the model
  // stops reporting one in the stratosphere) cannot carry moisture terms.
  const env: EnvLevel[] = [
    {
      pressureHpa: surfacePressure,
      temperatureC: surfaceT,
      dewPointC: surfaceTd,
      heightM: elevationM,
    },
  ];
  // A level with a temperature but no dew point keeps its temperature. The
  // model stops reporting dew point in the stratosphere, and dropping those
  // levels outright would lower the ceiling of the parcel ascent — reporting
  // a CAPE that is short and an equilibrium level that is really just where
  // the data stopped. Buoyancy is dominated by temperature, so the moisture
  // term is filled from relative humidity and, failing that, assumed dry.
  let assumedDry = 0;
  for (const level of levels) {
    const dewPointC =
      level.dewPointC ??
      (level.relativeHumidityPct === null
        ? null
        : dewPointFromRh(level.temperatureC, level.relativeHumidityPct));
    if (dewPointC === null) assumedDry += 1;
    env.push({
      pressureHpa: level.pressureHpa,
      temperatureC: level.temperatureC,
      // -80 C is drier than any reported atmospheric value; its mixing ratio
      // is ~1e-5 kg/kg, so the moisture term all but vanishes.
      dewPointC: dewPointC ?? -80,
      heightM: level.heightM,
    });
  }
  if (assumedDry > 0) {
    gaps.push(
      `${assumedDry} level(s) reported neither dew point nor relative humidity and were treated ` +
        'as dry. Their temperature is still used; precipitable water is a lower bound.',
    );
  }

  const thermodynamics: SoundingThermodynamics = {
    precipitableWaterMm: env.length > 1 ? precipitableWaterMm(env) : null,
    lapseRate0to3kmCPerKm: null,
    lapseRate700to500hPaCPerKm: lapseRateCPerKm(env, 700, 500),
    surfaceParcel: null,
    mixedLayerParcel: null,
  };

  if (env.length > 1) {
    const surfaceStart = {
      pressureHpa: surfacePressure,
      temperatureC: surfaceT,
      dewPointC: surfaceTd,
    };
    thermodynamics.surfaceParcel = toSoundingParcel(
      'surface',
      surfaceStart,
      liftParcel(env, surfaceStart),
      elevationM,
      levels,
    );
    const ml = mixedLayerParcel(env);
    if (ml !== null) {
      thermodynamics.mixedLayerParcel = toSoundingParcel(
        'mixed_layer_100hPa',
        ml,
        liftParcel(env, ml),
        elevationM,
        levels,
      );
    }
    // 0-3 km AGL expressed in pressure. Interpolated, not snapped to the
    // nearest reported level: on a 19-level profile the first level above
    // 3 km is often past 4 km, and a 4.2 km lapse rate labelled "0-3 km" is
    // a wrong number under a standard name.
    const threeKm = pressureAtHeight(env, elevationM + 3000);
    if (threeKm !== null) {
      thermodynamics.lapseRate0to3kmCPerKm = lapseRateCPerKm(env, surfacePressure, threeKm);
    }
  } else {
    gaps.push(
      'The model reported no usable pressure levels above the ground for this point, so no parcel was lifted.',
    );
  }

  // Wind profile in height above ground, surface wind first.
  const windProfile: WindLevel[] = [];
  const surfaceSpeed = first(body, 'wind_speed_10m');
  const surfaceDir = first(body, 'wind_direction_10m');
  if (surfaceSpeed !== null && surfaceDir !== null) {
    windProfile.push({
      heightAglM: SURFACE_WIND_HEIGHT_M,
      ...windComponents(surfaceSpeed, surfaceDir),
    });
  }
  for (const level of levels) {
    if (level.windSpeedMs === null || level.windDirectionDeg === null) continue;
    if (level.heightAglM <= SURFACE_WIND_HEIGHT_M) continue;
    windProfile.push({
      heightAglM: level.heightAglM,
      ...windComponents(level.windSpeedMs, level.windDirectionDeg),
    });
  }
  windProfile.sort((a, b) => a.heightAglM - b.heightAglM);

  const motions = bunkersStormMotion(windProfile);
  const mover = cyclonicMover(hemisphere);
  const cyclonic = motions === null ? null : mover === 'right' ? motions.right : motions.left;
  // South of the equator the mirror-image environment gives the integral the
  // opposite sign. Flipping it keeps "positive means favourable for a
  // cyclonic supercell" true in both hemispheres; the unflipped value is
  // returned alongside so nothing is hidden.
  const flip = hemisphere === 'southern' ? -1 : 1;
  const rawSrh = (topM: number): number | null =>
    cyclonic === null ? null : stormRelativeHelicity(windProfile, cyclonic, topM);
  const raw1 = rawSrh(1000);
  const raw3 = rawSrh(3000);

  const kinematics: SoundingKinematics = {
    hemisphere,
    cyclonicMover: mover,
    meanWind0to6km: layerWind(meanWind(windProfile, 0, 6000)),
    bunkersRight: layerWind(motions?.right ?? null),
    bunkersLeft: layerWind(motions?.left ?? null),
    bulkShear0to1kmMs: bulkShear(windProfile, SURFACE_WIND_HEIGHT_M, 1000)?.magnitudeMs ?? null,
    bulkShear0to3kmMs: bulkShear(windProfile, SURFACE_WIND_HEIGHT_M, 3000)?.magnitudeMs ?? null,
    bulkShear0to6kmMs: bulkShear(windProfile, SURFACE_WIND_HEIGHT_M, 6000)?.magnitudeMs ?? null,
    srh0to1kmM2S2: raw1 === null ? null : raw1 * flip,
    srh0to3kmM2S2: raw3 === null ? null : raw3 * flip,
    srh0to1kmRawM2S2: raw1,
    srh0to3kmRawM2S2: raw3,
    signConvention:
      hemisphere === 'southern'
        ? 'Southern Hemisphere: the cyclonic supercell is the LEFT mover, and the sign of the ' +
          'helicity integral is inverted relative to the Northern Hemisphere. srh0to1km/srh0to3km ' +
          'are reported flipped so positive still means favourable; *_raw are the unflipped integrals.'
        : 'Northern Hemisphere: the cyclonic supercell is the right mover and the helicity ' +
          'integral already has its usual sign, so the reported and raw values are identical.',
  };

  for (const parcel of [thermodynamics.surfaceParcel, thermodynamics.mixedLayerParcel]) {
    if (parcel?.capeTruncated === true) {
      gaps.push(
        `The ${parcel.label} parcel was still buoyant at the top of the profile, so its CAPE is a ` +
          'LOWER BOUND and no equilibrium level is reported. Do not quote it as the storm top.',
      );
    }
  }

  if (windProfile.length < 3) {
    gaps.push('Too few wind levels to compute storm motion or helicity for this point.');
  }

  gaps.push(
    'This is a model sounding, not a balloon. No radiosonde was launched here: every value is ' +
      'what a forecast model computed for this grid cell.',
    `The profile has ${levels.length} pressure levels, far coarser than a radiosonde's hundreds. ` +
      'A shallow inversion or a dry layer thinner than the level spacing is invisible to it, so ' +
      'CAPE and CIN from this profile are approximations.',
    'CAPE and CIN computed here are pseudoadiabatic and virtual-temperature corrected, lifted ' +
      'from the levels above. The values in `model` are the model’s own, at its native ' +
      'resolution. A difference between them is expected and is not an error in either.',
    'Composite indices (STP, SCP, SHIP) are deliberately absent: their published formulations are ' +
      'calibrated on Northern Hemisphere data and have no validated Southern Hemisphere form.',
    'The hemisphere convention in `kinematics` — cyclonic mover and helicity sign — is implemented ' +
      'but has NOT yet been validated against a documented case in either hemisphere, and no ' +
      'meteorologist has reviewed it. Treat the storm-motion and helicity numbers as provisional, ' +
      'and read the unflipped `*_raw` values if the convention matters to the answer.',
  );

  const sbCape = thermodynamics.surfaceParcel?.capeJkg;
  const coverage =
    `Model sounding for (${lat.toFixed(2)}, ${lon.toFixed(2)}) valid ${toUtcIso(time)}, ` +
    `${levels.length} pressure levels from ${Math.round(surfacePressure)} hPa upward, ` +
    `ground at ${Math.round(elevationM)} m. ` +
    (sbCape === undefined
      ? 'No parcel could be lifted.'
      : `Surface-parcel CAPE ${Math.round(sbCape)} J/kg against the model’s own ${
          model.capeJkg === null ? 'unreported' : `${Math.round(model.capeJkg)} J/kg`
        }.`);

  return {
    validTime: toUtcIso(time),
    lat,
    lon,
    elevationM,
    surfacePressureHpa: surfacePressure,
    surfaceTemperatureC: surfaceT,
    surfaceDewPointC: surfaceTd,
    levels,
    thermodynamics,
    kinematics,
    model,
    coverage,
    gaps,
    attribution,
  };
}
