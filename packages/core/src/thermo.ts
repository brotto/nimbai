/**
 * Thermodynamics and kinematics for vertical profiles.
 *
 * Pure functions, no I/O: everything here is testable against hand-computable
 * cases, which is the point. A sounding parameter that is quietly wrong is
 * worse than one that is absent, so each formula below names its source and
 * each has a test that does not merely re-run the implementation.
 *
 * Units, consistently: pressure hPa, temperature °C at the boundary and K
 * inside, mixing ratio kg/kg, height m, wind m/s, direction degrees
 * meteorological (the direction the wind comes FROM).
 */

/** Gas constant for dry air, J/(kg·K). */
export const RD = 287.04;
/** Specific heat of dry air at constant pressure, J/(kg·K). */
export const CP = 1005.7;
/** Ratio of the gas constants for dry air and water vapour. */
export const EPSILON = 0.622;
/** Standard gravity, m/s². */
export const G = 9.80665;
/** Latent heat of vaporisation at 0 °C, J/kg. */
const LV0 = 2.501e6;
const KAPPA = RD / CP;

const toK = (c: number): number => c + 273.15;
const toC = (k: number): number => k - 273.15;

/**
 * Saturation vapour pressure over liquid water, hPa.
 * Bolton (1980), eq. 10; accurate to 0.1 % for -35 °C ≤ T ≤ 35 °C.
 *
 * Over-water is used at every temperature, including far below freezing,
 * which is the convention US and Brazilian severe-weather practice follows.
 */
export function saturationVapourPressureHpa(temperatureC: number): number {
  return 6.112 * Math.exp((17.67 * temperatureC) / (temperatureC + 243.5));
}

/** Inverse of {@link saturationVapourPressureHpa}: dew point in °C. */
export function dewPointFromVapourPressure(vapourPressureHpa: number): number {
  const ln = Math.log(vapourPressureHpa / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

/** Dew point from temperature and relative humidity, °C. */
export function dewPointFromRh(temperatureC: number, rhPct: number): number {
  const rh = Math.min(Math.max(rhPct, 0.01), 100);
  return dewPointFromVapourPressure(saturationVapourPressureHpa(temperatureC) * (rh / 100));
}

/** Mixing ratio, kg/kg, from vapour pressure and total pressure. */
export function mixingRatio(vapourPressureHpa: number, pressureHpa: number): number {
  const e = Math.min(vapourPressureHpa, pressureHpa * 0.999);
  return (EPSILON * e) / (pressureHpa - e);
}

/** Saturation mixing ratio, kg/kg. */
export function saturationMixingRatio(temperatureC: number, pressureHpa: number): number {
  return mixingRatio(saturationVapourPressureHpa(temperatureC), pressureHpa);
}

/** Virtual temperature, K. Buoyancy is a virtual-temperature difference, not a dry one. */
export function virtualTemperatureK(temperatureK: number, mixingRatioKgKg: number): number {
  return (temperatureK * (1 + mixingRatioKgKg / EPSILON)) / (1 + mixingRatioKgKg);
}

/** Potential temperature, K. */
export function potentialTemperatureK(temperatureK: number, pressureHpa: number): number {
  return temperatureK * (1000 / pressureHpa) ** KAPPA;
}

/** Temperature of a dry-adiabatically displaced parcel, K. */
export function dryAdiabatK(temperatureK: number, fromHpa: number, toHpa: number): number {
  return temperatureK * (toHpa / fromHpa) ** KAPPA;
}

/** Latent heat of vaporisation at temperature T, J/kg (linear fit, Bolton 1980 §2). */
function latentHeat(temperatureK: number): number {
  return LV0 - 2370 * toC(temperatureK);
}

export interface Lcl {
  pressureHpa: number;
  temperatureC: number;
}

/**
 * Lifting condensation level of a parcel.
 *
 * Temperature from Bolton (1980), eq. 15; pressure then follows from Poisson's
 * equation, since potential temperature is conserved on the dry ascent to the
 * LCL. A saturated parcel (Td ≥ T) condenses where it stands.
 */
export function liftingCondensationLevel(
  temperatureC: number,
  dewPointC: number,
  pressureHpa: number,
): Lcl {
  if (dewPointC >= temperatureC) return { pressureHpa, temperatureC };
  const t = toK(temperatureC);
  const td = toK(dewPointC);
  const tLcl = 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56;
  return { pressureHpa: pressureHpa * (tLcl / t) ** (1 / KAPPA), temperatureC: toC(tLcl) };
}

/**
 * d(T)/d(ln p) along a pseudoadiabat, K per natural-log-pressure unit.
 * Standard moist-adiabatic lapse rate in pressure coordinates; see AMS
 * Glossary, "saturation-adiabatic lapse rate".
 */
function moistSlope(temperatureK: number, pressureHpa: number): number {
  const ws = saturationMixingRatio(toC(temperatureK), pressureHpa);
  const lv = latentHeat(temperatureK);
  const numerator = RD * temperatureK + lv * ws;
  const denominator = CP + (lv * lv * ws * EPSILON) / (RD * temperatureK * temperatureK);
  return numerator / denominator;
}

/**
 * Temperature after a pseudoadiabatic ascent, K. Second-order Runge-Kutta in
 * ln p, which is stable at the step sizes this module uses (≤ 0.01 in ln p,
 * about 10 hPa at 1000 hPa).
 */
export function moistAdiabatK(temperatureK: number, fromHpa: number, toHpa: number): number {
  const dlnp = Math.log(toHpa / fromHpa);
  const half = temperatureK + 0.5 * dlnp * moistSlope(temperatureK, fromHpa);
  const midP = fromHpa * Math.exp(0.5 * dlnp);
  return temperatureK + dlnp * moistSlope(half, midP);
}

/** One level of an environmental profile, as the parcel code needs it. */
export interface EnvLevel {
  pressureHpa: number;
  temperatureC: number;
  dewPointC: number;
  /** Geopotential height, m above mean sea level. */
  heightM: number;
}

function interpolate(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Environment sampled at an arbitrary pressure. Linear in ln p, which is the
 * usual choice: it is exact for an isothermal layer and close for the rest.
 * `levels` must be sorted by decreasing pressure (surface first).
 */
export function sampleEnvironment(
  levels: readonly EnvLevel[],
  pressureHpa: number,
): EnvLevel | null {
  const first = levels[0];
  const last = levels[levels.length - 1];
  if (first === undefined || last === undefined) return null;
  if (pressureHpa > first.pressureHpa || pressureHpa < last.pressureHpa) return null;
  for (let i = 1; i < levels.length; i++) {
    const lower = levels[i - 1] as EnvLevel;
    const upper = levels[i] as EnvLevel;
    if (pressureHpa <= lower.pressureHpa && pressureHpa >= upper.pressureHpa) {
      const x = Math.log(pressureHpa);
      const x0 = Math.log(lower.pressureHpa);
      const x1 = Math.log(upper.pressureHpa);
      return {
        pressureHpa,
        temperatureC: interpolate(x, x0, x1, lower.temperatureC, upper.temperatureC),
        dewPointC: interpolate(x, x0, x1, lower.dewPointC, upper.dewPointC),
        heightM: interpolate(x, x0, x1, lower.heightM, upper.heightM),
      };
    }
  }
  return null;
}

/**
 * The pressure at a geopotential height, the mirror of
 * {@link sampleEnvironment}. Needed because the profile is indexed by
 * pressure while the layers forecasters care about are in metres: snapping to
 * the nearest reported level instead would label a 4.2 km lapse rate "0-3 km".
 */
export function pressureAtHeight(levels: readonly EnvLevel[], heightM: number): number | null {
  const first = levels[0];
  const last = levels[levels.length - 1];
  if (first === undefined || last === undefined) return null;
  if (heightM < first.heightM || heightM > last.heightM) return null;
  for (let i = 1; i < levels.length; i++) {
    const lower = levels[i - 1] as EnvLevel;
    const upper = levels[i] as EnvLevel;
    if (heightM >= lower.heightM && heightM <= upper.heightM) {
      if (upper.heightM === lower.heightM) return lower.pressureHpa;
      const f = (heightM - lower.heightM) / (upper.heightM - lower.heightM);
      // Linear in ln p, consistent with how the profile is sampled.
      return Math.exp(
        Math.log(lower.pressureHpa) +
          f * (Math.log(upper.pressureHpa) - Math.log(lower.pressureHpa)),
      );
    }
  }
  return null;
}

export interface ParcelStart {
  pressureHpa: number;
  temperatureC: number;
  dewPointC: number;
}

/** One step of a lifted parcel, as a Skew-T plot needs it. */
export interface ParcelPoint {
  pressureHpa: number;
  temperatureC: number;
  /** Parcel minus environment virtual temperature, K. Positive is buoyant. */
  buoyancyK: number;
}

export interface ParcelResult {
  /** J/kg, integrated with the virtual-temperature correction. Never negative. */
  capeJkg: number;
  /** J/kg as a negative number, or null when the parcel never reaches an LFC. */
  cinJkg: number | null;
  lcl: Lcl;
  lclHeightM: number | null;
  lfcPressureHpa: number | null;
  lfcHeightM: number | null;
  elPressureHpa: number | null;
  elHeightM: number | null;
  /**
   * True when the parcel was still buoyant at the top of the environment, so
   * the ascent ran out of profile rather than reaching an equilibrium level.
   * `capeJkg` is then a lower bound and `elPressureHpa` is null.
   */
  capeTruncated: boolean;
  /** The whole ascent, decreasing pressure. Plot it against the environment. */
  path: ParcelPoint[];
}

/** Integration step in ln p. 0.004 is about 4 hPa at 1000 hPa, 1 hPa at 250. */
const DLNP = 0.004;

/**
 * Lifts a parcel through the environment and integrates its buoyancy.
 *
 * CAPE is the positive area between the LFC and the EL, CIN the negative area
 * below the LFC, both from the virtual temperature difference:
 * CAPE = Rd ∫ (Tv,parcel − Tv,env) d(−ln p). The parcel is pseudoadiabatic
 * above the LCL (condensate falls out), which is the convention SPC and
 * SHARPpy use and which gives slightly lower CAPE than a reversible ascent.
 */
export function liftParcel(
  levels: readonly EnvLevel[],
  start: ParcelStart,
  topHpa = 100,
): ParcelResult {
  const lcl = liftingCondensationLevel(start.temperatureC, start.dewPointC, start.pressureHpa);
  const w0 = mixingRatio(saturationVapourPressureHpa(start.dewPointC), start.pressureHpa);
  const highest = levels[levels.length - 1]?.pressureHpa ?? start.pressureHpa;
  const top = Math.max(topHpa, highest);

  type Node = ParcelPoint;

  const nodes: Node[] = [];
  let parcelK = toK(start.temperatureC);
  let previousP = start.pressureHpa;

  const pushNode = (p: number, tK: number): void => {
    const env = sampleEnvironment(levels, p);
    if (env === null) return;
    const saturated = p <= lcl.pressureHpa;
    const wParcel = saturated ? saturationMixingRatio(toC(tK), p) : w0;
    const wEnv = mixingRatio(saturationVapourPressureHpa(env.dewPointC), p);
    nodes.push({
      pressureHpa: p,
      temperatureC: toC(tK),
      buoyancyK:
        virtualTemperatureK(tK, wParcel) - virtualTemperatureK(toK(env.temperatureC), wEnv),
    });
  };

  pushNode(start.pressureHpa, parcelK);

  // The LCL is an explicit node so the change of lapse rate falls exactly on a
  // step boundary instead of being smeared across one.
  const stops: number[] = [];
  for (let p = start.pressureHpa; p > top;) {
    const next = p * Math.exp(-DLNP);
    if (p > lcl.pressureHpa && next < lcl.pressureHpa) stops.push(lcl.pressureHpa);
    stops.push(Math.max(next, top));
    p = next;
  }

  for (const p of stops) {
    parcelK =
      previousP <= lcl.pressureHpa
        ? moistAdiabatK(parcelK, previousP, p)
        : dryAdiabatK(parcelK, previousP, p);
    pushNode(p, parcelK);
    previousP = p;
  }

  /** Area of the segment ending at node `i`, J/kg: Rd·ΔTv·Δ(−ln p). */
  const segmentArea = (i: number): number => {
    const lower = nodes[i - 1] as Node;
    const upper = nodes[i] as Node;
    const mean = (lower.buoyancyK + upper.buoyancyK) / 2;
    return RD * mean * Math.log(lower.pressureHpa / upper.pressureHpa);
  };

  // Free convection can only begin at or above the LCL: below it the ascent is
  // forced, whatever the buoyancy. A profile can hold several positive layers
  // — a shallow superadiabatic surface bubble under a cap, then the real
  // storm layer above it — so the CAPE layer is the largest of them, and the
  // LFC is its base. Taking the lowest positive crossing instead would put
  // the LFC under the cap and report the inhibition as zero.
  const lclIndex = nodes.findIndex((n) => n.pressureHpa <= lcl.pressureHpa);
  let lfcIndex = -1;
  let elIndex = -1;
  let truncated = false;
  let cape = 0;
  let runStart = -1;
  let runArea = 0;
  for (let i = Math.max(lclIndex, 0); lclIndex >= 0 && i < nodes.length; i++) {
    const buoyant = (nodes[i] as Node).buoyancyK > 0;
    if (buoyant && runStart === -1) {
      runStart = i;
      runArea = 0;
    }
    if (buoyant && i > runStart) runArea += Math.max(segmentArea(i), 0);
    if ((!buoyant || i === nodes.length - 1) && runStart !== -1) {
      const end = buoyant ? i : i - 1;
      if (runArea > cape) {
        cape = runArea;
        lfcIndex = runStart;
        elIndex = end;
        // Still buoyant at the last node: the ascent ran out of profile. The
        // top of the integration is not an equilibrium level, and calling it
        // one invents a storm top out of where the data happened to stop.
        truncated = buoyant && i === nodes.length - 1;
      }
      runStart = -1;
    }
  }

  // Everything working against that ascent, from the parcel's own level up to
  // the LFC: the cap a storm has to break, not just the part above the LCL.
  //
  // Signed, as SPC, SHARPpy and MetPy define it: positive area below the LFC
  // offsets the negative. Summing only the negative segments would report a
  // cap a parcel does not actually have to break, and an overstated cap reads
  // as "nothing will fire".
  let cin = 0;
  if (lfcIndex > 0) {
    for (let i = 1; i <= lfcIndex; i++) cin += segmentArea(i);
    cin = Math.min(0, cin);
  }

  const heightAt = (p: number | null): number | null => {
    if (p === null) return null;
    return sampleEnvironment(levels, p)?.heightM ?? null;
  };
  const lfcP = lfcIndex >= 0 ? (nodes[lfcIndex] as Node).pressureHpa : null;
  const elP = elIndex >= 0 && !truncated ? (nodes[elIndex] as Node).pressureHpa : null;

  return {
    capeJkg: cape,
    cinJkg: lfcIndex >= 0 ? cin : null,
    lcl,
    lclHeightM: heightAt(lcl.pressureHpa),
    lfcPressureHpa: lfcP,
    lfcHeightM: heightAt(lfcP),
    elPressureHpa: elP,
    elHeightM: heightAt(elP),
    capeTruncated: truncated,
    path: nodes,
  };
}

/**
 * Parcel representing the lowest `depthHpa` of the profile, mixed: mean
 * potential temperature and mean mixing ratio, brought back to the surface.
 * This is the parcel a storm actually ingests when the boundary layer is well
 * mixed, and it is usually less optimistic than the surface parcel.
 */
export function mixedLayerParcel(levels: readonly EnvLevel[], depthHpa = 100): ParcelStart | null {
  const surface = levels[0];
  if (surface === undefined) return null;
  const bottom = surface.pressureHpa;
  const topP = bottom - depthHpa;

  let thetaSum = 0;
  let wSum = 0;
  let weight = 0;
  const step = 5;
  for (let p = bottom; p >= topP; p -= step) {
    const env = sampleEnvironment(levels, p);
    if (env === null) continue;
    thetaSum += potentialTemperatureK(toK(env.temperatureC), p);
    wSum += mixingRatio(saturationVapourPressureHpa(env.dewPointC), p);
    weight += 1;
  }
  if (weight === 0) return null;

  const theta = thetaSum / weight;
  const w = wSum / weight;
  const tK = theta * (bottom / 1000) ** KAPPA;
  // Invert the mixing ratio to get the dew point the mixed parcel starts with.
  const e = (w * bottom) / (EPSILON + w);
  return {
    pressureHpa: bottom,
    temperatureC: toC(tK),
    dewPointC: dewPointFromVapourPressure(e),
  };
}

/**
 * Precipitable water, mm, integrated over the profile.
 *
 * PW = (1/g) ∫ q dp, with q the SPECIFIC humidity and dp in Pa. Integrating
 * the mixing ratio instead, as some quick implementations do, overstates it
 * by w/(1+w) — about 1 % in the tropics.
 */
export function precipitableWaterMm(levels: readonly EnvLevel[]): number {
  const specific = (dewPointC: number, pressureHpa: number): number => {
    const w = mixingRatio(saturationVapourPressureHpa(dewPointC), pressureHpa);
    return w / (1 + w);
  };
  let total = 0;
  for (let i = 1; i < levels.length; i++) {
    const lower = levels[i - 1] as EnvLevel;
    const upper = levels[i] as EnvLevel;
    const ql = specific(lower.dewPointC, lower.pressureHpa);
    const qu = specific(upper.dewPointC, upper.pressureHpa);
    total += (((ql + qu) / 2) * (lower.pressureHpa - upper.pressureHpa) * 100) / G;
  }
  return total;
}

/** Lapse rate between two pressures, °C/km. Positive means temperature falling with height. */
export function lapseRateCPerKm(
  levels: readonly EnvLevel[],
  bottomHpa: number,
  topHpa: number,
): number | null {
  const bottom = sampleEnvironment(levels, bottomHpa);
  const top = sampleEnvironment(levels, topHpa);
  if (bottom === null || top === null) return null;
  const dz = (top.heightM - bottom.heightM) / 1000;
  if (dz <= 0) return null;
  return (bottom.temperatureC - top.temperatureC) / dz;
}

export interface Wind {
  /** Eastward component, m/s. */
  u: number;
  /** Northward component, m/s. */
  v: number;
}

/** Meteorological wind (direction it blows FROM) to components. */
export function windComponents(speedMs: number, directionDeg: number): Wind {
  const rad = (directionDeg * Math.PI) / 180;
  return { u: -speedMs * Math.sin(rad), v: -speedMs * Math.cos(rad) };
}

/** Components back to speed and the meteorological direction. */
export function windFromComponents(wind: Wind): { speedMs: number; directionDeg: number } {
  const speedMs = Math.hypot(wind.u, wind.v);
  if (speedMs === 0) return { speedMs: 0, directionDeg: 0 };
  const deg = (Math.atan2(-wind.u, -wind.v) * 180) / Math.PI;
  return { speedMs, directionDeg: (deg + 360) % 360 };
}

/** A wind observation at a height above ground. */
export interface WindLevel extends Wind {
  heightAglM: number;
}

/** Linear interpolation of the wind profile to one height AGL. */
export function windAt(profile: readonly WindLevel[], heightAglM: number): Wind | null {
  const first = profile[0];
  const last = profile[profile.length - 1];
  if (first === undefined || last === undefined) return null;
  if (heightAglM < first.heightAglM || heightAglM > last.heightAglM) return null;
  for (let i = 1; i < profile.length; i++) {
    const lower = profile[i - 1] as WindLevel;
    const upper = profile[i] as WindLevel;
    if (heightAglM >= lower.heightAglM && heightAglM <= upper.heightAglM) {
      return {
        u: interpolate(heightAglM, lower.heightAglM, upper.heightAglM, lower.u, upper.u),
        v: interpolate(heightAglM, lower.heightAglM, upper.heightAglM, lower.v, upper.v),
      };
    }
  }
  return null;
}

/**
 * Mean wind over a layer, sampled every 100 m.
 *
 * The bottom is raised to the lowest level the profile actually has, which is
 * the anemometer height rather than the ground: starting at 0 would silently
 * drop the surface wind from every layer mean, since nothing is reported
 * below it. The top is not forgiving in the same way — a profile that stops
 * at 1.3 km returns null for a 0-6 km mean rather than a 0-1.3 km mean
 * wearing the deeper layer's name.
 */
export function meanWind(
  profile: readonly WindLevel[],
  bottomM: number,
  topM: number,
): Wind | null {
  const base = Math.max(bottomM, profile[0]?.heightAglM ?? bottomM);
  const ceiling = profile[profile.length - 1]?.heightAglM;
  if (ceiling === undefined || base > topM || ceiling < topM) return null;
  let u = 0;
  let v = 0;
  let n = 0;
  for (let z = base; z <= topM; z += 100) {
    const w = windAt(profile, z);
    if (w === null) continue;
    u += w.u;
    v += w.v;
    n += 1;
  }
  return n === 0 ? null : { u: u / n, v: v / n };
}

/** Vector wind difference across a layer. Its magnitude is the bulk shear. */
export function bulkShear(
  profile: readonly WindLevel[],
  bottomM: number,
  topM: number,
): (Wind & { magnitudeMs: number }) | null {
  const bottom = windAt(profile, bottomM);
  const top = windAt(profile, topM);
  if (bottom === null || top === null) return null;
  const u = top.u - bottom.u;
  const v = top.v - bottom.v;
  return { u, v, magnitudeMs: Math.hypot(u, v) };
}

/** Bunkers et al. (2000) deviation from the mean wind, m/s. */
const BUNKERS_D = 7.5;

export interface StormMotions {
  mean0to6km: Wind;
  right: Wind;
  left: Wind;
}

/**
 * Bunkers ID-method supercell motion.
 *
 * Both members are geometric: the right mover deviates clockwise from the
 * 0-6 km shear vector and the left mover anticlockwise, in either hemisphere.
 * Which of the two rotates cyclonically is NOT geometry but hemisphere — see
 * {@link cyclonicMover}.
 */
export function bunkersStormMotion(profile: readonly WindLevel[]): StormMotions | null {
  const mean = meanWind(profile, 0, 6000);
  const low = meanWind(profile, 0, 500);
  const high = meanWind(profile, 5500, 6000);
  if (mean === null || low === null || high === null) return null;

  const shearU = high.u - low.u;
  const shearV = high.v - low.v;
  const magnitude = Math.hypot(shearU, shearV);
  if (magnitude === 0) return { mean0to6km: mean, right: mean, left: mean };

  // (shear × k̂)/|shear| is the shear vector turned 90° clockwise.
  const du = (BUNKERS_D * shearV) / magnitude;
  const dv = (-BUNKERS_D * shearU) / magnitude;
  return {
    mean0to6km: mean,
    right: { u: mean.u + du, v: mean.v + dv },
    left: { u: mean.u - du, v: mean.v - dv },
  };
}

export type Hemisphere = 'northern' | 'southern';

export function hemisphereOf(lat: number): Hemisphere {
  return lat < 0 ? 'southern' : 'northern';
}

/**
 * Which Bunkers member rotates cyclonically, and therefore which one a
 * tornado forecast is about.
 *
 * In the Northern Hemisphere that is the right mover. South of the equator
 * the Coriolis parameter changes sign and the mirror image holds: the
 * cyclonic, mesocyclone-bearing supercell is the LEFT mover. Applying the
 * Northern convention to Brazil would point every tornado parameter at the
 * wrong storm. See `wiki/decisions/2026-10-28-parametros-hemisferio-sul.md`.
 */
export function cyclonicMover(hemisphere: Hemisphere): 'right' | 'left' {
  return hemisphere === 'northern' ? 'right' : 'left';
}

/**
 * Storm-relative helicity over a layer, m²/s², relative to storm motion `c`.
 *
 * SRH = ∫ (V − c) · (k̂ × ∂V/∂z) dz, discretised over 100 m steps. The sign is
 * as the integral gives it: in the Northern Hemisphere a cyclonically curved
 * hodograph yields a positive number, in the Southern Hemisphere the mirror
 * situation yields a negative one. Callers that want "positive means
 * favourable" must flip the sign south of the equator; this function does not
 * do it for them, so the raw physical quantity stays available.
 */
export function stormRelativeHelicity(
  profile: readonly WindLevel[],
  motion: Wind,
  topM: number,
  bottomM = 0,
): number | null {
  let total = 0;
  let counted = 0;
  const base = Math.max(bottomM, profile[0]?.heightAglM ?? bottomM);
  for (let z = base; z < topM; z += 100) {
    const lower = windAt(profile, z);
    const upper = windAt(profile, Math.min(z + 100, topM));
    if (lower === null || upper === null) continue;
    total +=
      (upper.u - motion.u) * (lower.v - motion.v) - (lower.u - motion.u) * (upper.v - motion.v);
    counted += 1;
  }
  return counted === 0 ? null : total;
}
