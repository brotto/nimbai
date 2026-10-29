import { describe, expect, it } from 'vitest';
import {
  G,
  RD,
  bulkShear,
  bunkersStormMotion,
  cyclonicMover,
  dewPointFromRh,
  dryAdiabatK,
  hemisphereOf,
  lapseRateCPerKm,
  liftParcel,
  liftingCondensationLevel,
  meanWind,
  mixedLayerParcel,
  mixingRatio,
  moistAdiabatK,
  potentialTemperatureK,
  precipitableWaterMm,
  pressureAtHeight,
  sampleEnvironment,
  saturationMixingRatio,
  saturationVapourPressureHpa,
  stormRelativeHelicity,
  virtualTemperatureK,
  windComponents,
  windFromComponents,
  type EnvLevel,
  type WindLevel,
} from './thermo.js';

describe('moisture', () => {
  it('matches the published saturation vapour pressure', () => {
    // Smithsonian tables: 6.11 hPa at 0 C, 23.37 at 20, 42.43 at 30.
    expect(saturationVapourPressureHpa(0)).toBeCloseTo(6.112, 2);
    expect(saturationVapourPressureHpa(20)).toBeCloseTo(23.37, 1);
    expect(saturationVapourPressureHpa(30)).toBeCloseTo(42.43, 1);
  });

  it('round-trips dew point through relative humidity', () => {
    const td = dewPointFromRh(25, 60);
    expect(td).toBeCloseTo(16.7, 1);
    const e = saturationVapourPressureHpa(td);
    expect((e / saturationVapourPressureHpa(25)) * 100).toBeCloseTo(60, 6);
  });

  it('gives dew point equal to temperature at saturation', () => {
    expect(dewPointFromRh(17.3, 100)).toBeCloseTo(17.3, 6);
  });

  it('computes mixing ratio against a hand calculation', () => {
    // w = 0.622 * 12 / (1000 - 12) = 7.555 g/kg
    expect(mixingRatio(12, 1000)).toBeCloseTo(0.0075547, 7);
  });

  it('makes moist air lighter: virtual temperature exceeds temperature', () => {
    const w = saturationMixingRatio(25, 1000);
    expect(virtualTemperatureK(298.15, w)).toBeGreaterThan(298.15);
    expect(virtualTemperatureK(298.15, 0)).toBeCloseTo(298.15, 10);
  });
});

describe('adiabats', () => {
  it('conserves potential temperature on a dry ascent', () => {
    const theta = potentialTemperatureK(300, 1000);
    const lifted = dryAdiabatK(300, 1000, 700);
    expect(potentialTemperatureK(lifted, 700)).toBeCloseTo(theta, 8);
  });

  it('reproduces the textbook saturated lapse rate', () => {
    // dT/dz = -(g/(Rd T)) * dT/dlnp. Warm and moist near the surface the
    // saturated rate is about 4.5 K/km; cold aloft it approaches the dry rate.
    const rate = (tC: number, p: number): number => {
      const t = tC + 273.15;
      const dp = 0.001;
      const slope = (moistAdiabatK(t, p, p * Math.exp(-dp)) - t) / -dp;
      return (slope * G * 1000) / (RD * t);
    };
    expect(rate(20, 1000)).toBeGreaterThan(4.0);
    expect(rate(20, 1000)).toBeLessThan(5.0);
    expect(rate(-20, 500)).toBeGreaterThan(6.5);
    expect(rate(-20, 500)).toBeLessThan(8.5);
  });

  it('traces the published pseudoadiabats', () => {
    // A parcel saturated at 1000 hPa / 20 C follows the theta-w = 20 C
    // pseudoadiabat, whose positions on a tephigram are tabulated. These
    // targets come from the chart, not from this implementation.
    const lift = (fromC: number, toHpa: number): number => {
      let t = fromC + 273.15;
      let p = 1000;
      const steps = 50;
      for (let i = 0; i < steps; i++) {
        const a = p * Math.exp((Math.log(toHpa / p) * i) / steps);
        const b = p * Math.exp((Math.log(toHpa / p) * (i + 1)) / steps);
        t = moistAdiabatK(t, a, b);
      }
      return t - 273.15;
    };
    expect(lift(20, 850)).toBeCloseTo(14, 0);
    expect(lift(20, 700)).toBeCloseTo(6, 0);
    expect(lift(20, 500)).toBeCloseTo(-9, 0);
    expect(lift(20, 300)).toBeCloseTo(-37, 0);
    expect(lift(10, 700)).toBeCloseTo(-7, 0);
    expect(lift(10, 500)).toBeCloseTo(-26, 0);
  });

  it('integrates the moist adiabat independently of the step size', () => {
    const oneStep = moistAdiabatK(293.15, 1000, 800);
    let many = 293.15;
    for (let i = 0; i < 200; i++) {
      const from = 1000 * (800 / 1000) ** (i / 200);
      const to = 1000 * (800 / 1000) ** ((i + 1) / 200);
      many = moistAdiabatK(many, from, to);
    }
    expect(oneStep).toBeCloseTo(many, 1);
  });

  it('cools a saturated parcel more slowly than a dry one', () => {
    expect(moistAdiabatK(293.15, 1000, 700)).toBeGreaterThan(dryAdiabatK(293.15, 1000, 700));
  });
});

describe('liftingCondensationLevel', () => {
  it('leaves a saturated parcel at its own level', () => {
    const lcl = liftingCondensationLevel(18, 18, 980);
    expect(lcl.pressureHpa).toBe(980);
    expect(lcl.temperatureC).toBe(18);
  });

  it('puts the parcel exactly at saturation there, whatever the formula', () => {
    // Independent of Bolton: a parcel at its LCL must be saturated, so its
    // conserved mixing ratio must equal the saturation value at (p, T) there.
    for (const [t, td, p] of [
      [30, 20, 1000],
      [10, -5, 950],
      [35, 24, 1013],
    ] as const) {
      const lcl = liftingCondensationLevel(t, td, p);
      const conserved = mixingRatio(saturationVapourPressureHpa(td), p);
      const atLcl = saturationMixingRatio(lcl.temperatureC, lcl.pressureHpa);
      expect(atLcl / conserved).toBeCloseTo(1, 2);
    }
  });

  it('follows Espy: roughly 125 m of LCL height per degree of dew point depression', () => {
    const lcl = liftingCondensationLevel(30, 20, 1000);
    // Hypsometric height of the LCL above a 1000 hPa surface.
    const meanT = (303.15 + (lcl.temperatureC + 273.15)) / 2;
    const height = ((RD * meanT) / G) * Math.log(1000 / lcl.pressureHpa);
    expect(height).toBeGreaterThan(1000);
    expect(height).toBeLessThan(1500);
  });
});

/** Builds an environment on a chosen temperature profile, with heights from the hypsometric equation. */
function buildEnv(
  pressures: readonly number[],
  temperatureAt: (p: number) => number,
  dewPointAt: (p: number) => number,
  surfaceHeightM = 0,
): EnvLevel[] {
  const levels: EnvLevel[] = [];
  let height = surfaceHeightM;
  let previous: number | undefined;
  for (const p of pressures) {
    const temperatureC = temperatureAt(p);
    if (previous !== undefined) {
      const meanT = (temperatureC + temperatureAt(previous)) / 2 + 273.15;
      height += ((RD * meanT) / G) * Math.log(previous / p);
    }
    levels.push({ pressureHpa: p, temperatureC, dewPointC: dewPointAt(p), heightM: height });
    previous = p;
  }
  return levels;
}

const STANDARD_PRESSURES = [
  1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100,
];

/**
 * The committed Foz do Iguaçu profile (29 Oct 2026 18:00 UTC), as the
 * sounding adapter builds it: surface first, levels below ground dropped,
 * stratospheric levels with no reported dew point treated as dry.
 */
function fozProfile(): EnvLevel[] {
  return (
    [
      [994, 21.0, 19.6, 173.0],
      [975, 21.6, 17.6, 343.62],
      [950, 19.5, 16.7, 568.0],
      [925, 17.9, 14.4, 798.0],
      [900, 16.3, 14.6, 1032.0],
      [850, 13.5, 10.9, 1517.0],
      [800, 10.5, 8.6, 2026.0],
      [700, 4.4, 3.4, 3126.0],
      [600, -2.2, -3.8, 4369.0],
      [500, -9.3, -18.5, 5799.0],
      [400, -21.6, -26.5, 7483.95],
      [300, -36.0, -50.1, 9540.32],
      [250, -45.5, -53.5, 10779.05],
      [200, -51.5, -71.4, 12241.86],
      [150, -61.0, -80.7, 14068.66],
      [100, -71.5, -86.0, 16516.67],
      [70, -66.5, -87.6, 18639.34],
      [50, -63.5, -80, 20696.55],
      [30, -61.0, -80, 23859.82],
    ] as const
  ).map(([pressureHpa, temperatureC, dewPointC, heightM]) => ({
    pressureHpa,
    temperatureC,
    dewPointC,
    heightM,
  }));
}

/** Warm layer from 900 to 850 hPa over a moist surface: real inhibition, real CAPE above it. */
function cappedEnv(): EnvLevel[] {
  return buildEnv(
    STANDARD_PRESSURES,
    (p) => (p > 900 ? 28 : p >= 850 ? 27 : 27 - 9 * (850 - p) * 0.0125),
    (p) => (p >= 900 ? 22 - 6 * (1000 - p) * 0.0125 : 4 - 9 * (900 - p) * 0.0125),
  );
}

describe('liftParcel', () => {
  it('finds no CAPE in an isothermal, dry atmosphere', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      () => 0,
      () => -40,
    );
    const parcel = liftParcel(env, { pressureHpa: 1000, temperatureC: 0, dewPointC: -40 });
    expect(parcel.capeJkg).toBe(0);
    expect(parcel.lfcPressureHpa).toBeNull();
    expect(parcel.elPressureHpa).toBeNull();
    expect(parcel.cinJkg).toBeNull();
  });

  it('finds no CAPE when the environment is the parcel’s own moist adiabat', () => {
    // A saturated parcel lifted through its own adiabat is neutrally buoyant
    // at every level, so the positive area must vanish.
    const path = new Map<number, number>();
    let t = 293.15;
    let previous = 1000;
    for (const p of STANDARD_PRESSURES) {
      t = p === 1000 ? t : moistAdiabatK(t, previous, p);
      path.set(p, t - 273.15);
      previous = p;
    }
    const at = (p: number): number => path.get(p) ?? 0;
    const env = buildEnv(STANDARD_PRESSURES, at, at);
    const parcel = liftParcel(env, { pressureHpa: 1000, temperatureC: 20, dewPointC: 20 });
    expect(parcel.capeJkg).toBeLessThan(15);
  });

  it('reproduces an independently computed CAPE and CIN', () => {
    // These targets come from a separate implementation of the same physics
    // (written in Python from Bolton 1980 and the pseudoadiabat, integrating
    // at 0.5 hPa steps rather than in log-pressure) run over the committed
    // Foz do Iguaçu profile: CAPE 548.20 J/kg, CIN -20.55 J/kg, LCL
    // 973.62 hPa. Pinning absolute values, not inequalities: a CAPE that
    // drifts by a factor of two has to fail something.
    const env = fozProfile();
    const parcel = liftParcel(env, { pressureHpa: 994, temperatureC: 21, dewPointC: 19.6 });
    expect(parcel.lcl.pressureHpa).toBeCloseTo(973.62, 1);
    expect(parcel.capeJkg).toBeCloseTo(548.2, 0);
    expect(parcel.cinJkg as number).toBeCloseTo(-20.55, 0);
    expect(parcel.elPressureHpa as number).toBeCloseTo(301, -0.5);
    expect(parcel.capeTruncated).toBe(false);
  });

  it('refuses to call the top of the profile an equilibrium level', () => {
    // Environment far colder than the parcel all the way up: the ascent runs
    // out of data while still buoyant. Reporting the last level as the EL
    // would invent a storm top out of where the profile happened to stop.
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 28 - 12 * (1000 - p) * 0.0125,
      () => -25,
    );
    const parcel = liftParcel(env, { pressureHpa: 1000, temperatureC: 28, dewPointC: 24 });
    expect(parcel.capeJkg).toBeGreaterThan(0);
    expect(parcel.capeTruncated).toBe(true);
    expect(parcel.elPressureHpa).toBeNull();
    expect(parcel.elHeightM).toBeNull();
  });

  it('reports CIN as a negative number and puts the LFC above the LCL', () => {
    const parcel = liftParcel(cappedEnv(), { pressureHpa: 1000, temperatureC: 28, dewPointC: 22 });
    expect(parcel.cinJkg).not.toBeNull();
    expect(parcel.cinJkg as number).toBeLessThan(0);
    expect(parcel.capeJkg).toBeGreaterThan(500);
    // Lower pressure means higher up: the LFC sits above the LCL, the EL above both.
    expect(parcel.lfcPressureHpa as number).toBeLessThan(parcel.lcl.pressureHpa);
    expect(parcel.elPressureHpa as number).toBeLessThan(parcel.lfcPressureHpa as number);
  });

  it('picks the deep CAPE layer, not a shallow buoyant layer above the LCL', () => {
    // A thin cold notch just above the LCL makes the parcel briefly buoyant,
    // then the cap stops it again before the real storm layer. Taking the
    // first positive crossing above the LCL as the LFC would anchor the CAPE
    // layer to the notch and report almost no inhibition.
    const notched = cappedEnv().map((l) =>
      l.pressureHpa === 900 ? { ...l, temperatureC: l.temperatureC - 9 } : l,
    );
    const parcel = liftParcel(notched, { pressureHpa: 1000, temperatureC: 28, dewPointC: 22 });
    const plain = liftParcel(cappedEnv(), {
      pressureHpa: 1000,
      temperatureC: 28,
      dewPointC: 22,
    });
    // The deep layer above the cap is still the one chosen.
    expect(parcel.lfcPressureHpa as number).toBeLessThan(850);
    expect(parcel.capeJkg).toBeCloseTo(plain.capeJkg, -2);
    expect(parcel.cinJkg as number).toBeLessThan(-100);
  });

  it('nets positive area below the LFC against the negative, as CIN is defined', () => {
    // A warm notch under the cap gives the parcel a patch of buoyancy on the
    // way up. Summing only the negative segments would report a cap the
    // parcel does not actually have to break, and an overstated cap reads as
    // "nothing will fire".
    const env = cappedEnv().map((l) =>
      l.pressureHpa === 950 ? { ...l, temperatureC: l.temperatureC - 6 } : l,
    );
    const parcel = liftParcel(env, { pressureHpa: 1000, temperatureC: 28, dewPointC: 22 });
    const lfc = parcel.lfcPressureHpa as number;

    let negativeOnly = 0;
    let signed = 0;
    for (let i = 1; i < parcel.path.length; i++) {
      const lower = parcel.path[i - 1]!;
      const upper = parcel.path[i]!;
      if (upper.pressureHpa < lfc) break;
      const area =
        RD *
        ((lower.buoyancyK + upper.buoyancyK) / 2) *
        Math.log(lower.pressureHpa / upper.pressureHpa);
      signed += area;
      if (area < 0) negativeOnly += area;
    }
    expect(negativeOnly).toBeLessThan(signed);
    expect(parcel.cinJkg as number).toBeCloseTo(signed, 0);
    expect(parcel.cinJkg as number).toBeGreaterThan(negativeOnly);
  });

  it('never reports a positive CIN', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 30 - 9.5 * (1000 - p) * 0.0125,
      () => 23,
    );
    const parcel = liftParcel(env, { pressureHpa: 1000, temperatureC: 30, dewPointC: 23 });
    expect(parcel.cinJkg as number).toBeLessThanOrEqual(0);
  });

  it('never returns a negative CAPE', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 10 + (1000 - p) * 0.004,
      () => -30,
    );
    expect(liftParcel(env, { pressureHpa: 1000, temperatureC: 10, dewPointC: -30 }).capeJkg).toBe(
      0,
    );
  });

  it('walks the ascent from the start pressure upward', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 25 - 6.5 * (1000 - p) * 0.0125,
      () => 15,
    );
    const { path } = liftParcel(env, { pressureHpa: 1000, temperatureC: 25, dewPointC: 15 });
    expect(path[0]?.pressureHpa).toBe(1000);
    expect(path[path.length - 1]?.pressureHpa).toBeLessThanOrEqual(100);
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.pressureHpa).toBeLessThan(path[i - 1]!.pressureHpa);
      expect(path[i]!.temperatureC).toBeLessThan(path[i - 1]!.temperatureC);
    }
  });
});

describe('mixedLayerParcel', () => {
  it('is cooler and drier than the surface when the surface is a hot, moist bubble', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => (p >= 995 ? 34 : 24 - 6.5 * (1000 - p) * 0.0125),
      (p) => (p >= 995 ? 24 : 14),
    );
    // Surface node of this profile is 1000 hPa / 34 C / 24 C.
    const ml = mixedLayerParcel(env);
    expect(ml).not.toBeNull();
    expect((ml as { temperatureC: number }).temperatureC).toBeLessThan(34);
    expect((ml as { dewPointC: number }).dewPointC).toBeLessThan(24);
  });

  it('returns the surface parcel back when the layer is already well mixed', () => {
    // Dry adiabatic and constant mixing ratio: mixing changes nothing.
    const theta = potentialTemperatureK(300.15, 1000);
    const w = mixingRatio(saturationVapourPressureHpa(15), 1000);
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => theta * (p / 1000) ** (RD / 1005.7) - 273.15,
      (p) => {
        const e = (w * p) / (0.622 + w);
        const ln = Math.log(e / 6.112);
        return (243.5 * ln) / (17.67 - ln);
      },
    );
    const ml = mixedLayerParcel(env);
    expect((ml as { temperatureC: number }).temperatureC).toBeCloseTo(27, 0);
    expect((ml as { dewPointC: number }).dewPointC).toBeCloseTo(15, 0);
  });
});

describe('precipitableWaterMm', () => {
  it('matches a hand-integrated single layer', () => {
    // Worked by hand, not by re-running the implementation:
    //   es(14.0 C) = 15.973 hPa -> w = 0.0100965 -> q = 0.0099956
    //   es(12.6 C) = 14.579 hPa -> w = 0.0102427 -> q = 0.0101388
    //   PW = mean(q) * 10000 Pa / 9.80665 = 10.266 mm
    const env: EnvLevel[] = [
      { pressureHpa: 1000, temperatureC: 20, dewPointC: 14.0, heightM: 0 },
      { pressureHpa: 900, temperatureC: 14, dewPointC: 12.6, heightM: 900 },
    ];
    expect(precipitableWaterMm(env)).toBeCloseTo(10.266, 3);
  });

  it('integrates specific humidity, not mixing ratio', () => {
    // The same layer through the mixing ratio gives 10.370 mm: about 1 % high.
    // Pinning the gap keeps the cheaper, wrong integral from creeping back.
    const env: EnvLevel[] = [
      { pressureHpa: 1000, temperatureC: 20, dewPointC: 14.0, heightM: 0 },
      { pressureHpa: 900, temperatureC: 14, dewPointC: 12.6, heightM: 900 },
    ];
    const viaMixingRatio =
      (((mixingRatio(saturationVapourPressureHpa(14), 1000) +
        mixingRatio(saturationVapourPressureHpa(12.6), 900)) /
        2) *
        100 *
        100) /
      G;
    expect(viaMixingRatio).toBeCloseTo(10.37, 2);
    expect(precipitableWaterMm(env)).toBeLessThan(viaMixingRatio);
  });

  it('is zero for a bone-dry profile', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      () => 0,
      () => -90,
    );
    expect(precipitableWaterMm(env)).toBeLessThan(0.2);
  });
});

describe('lapseRateCPerKm', () => {
  it('returns the imposed rate', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 20 - 6.5 * ((1000 - p) * 0.0125),
      () => -20,
    );
    const rate = lapseRateCPerKm(env, 1000, 500);
    expect(rate).not.toBeNull();
    // 6.5 C per 12.5 hPa*... the construction is in pressure, so just check
    // it lands in the physically sensible band rather than restating it.
    expect(rate as number).toBeGreaterThan(4);
    expect(rate as number).toBeLessThan(9);
  });

  it('is negative through an inversion', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => (p >= 900 ? 10 + (1000 - p) * 0.1 : 20),
      () => 0,
    );
    expect(lapseRateCPerKm(env, 1000, 900) as number).toBeLessThan(0);
  });
});

describe('wind vectors', () => {
  it('converts the four cardinal directions the meteorological way', () => {
    // A "northerly" wind blows FROM the north, so it points south: v < 0.
    expect(windComponents(10, 0).v).toBeCloseTo(-10, 10);
    expect(windComponents(10, 0).u).toBeCloseTo(0, 10);
    expect(windComponents(10, 90).u).toBeCloseTo(-10, 10);
    expect(windComponents(10, 180).v).toBeCloseTo(10, 10);
    expect(windComponents(10, 270).u).toBeCloseTo(10, 10);
  });

  it('round-trips through components', () => {
    for (const dir of [0, 45, 137, 270, 359]) {
      const back = windFromComponents(windComponents(12.5, dir));
      expect(back.speedMs).toBeCloseTo(12.5, 9);
      expect(back.directionDeg).toBeCloseTo(dir, 6);
    }
  });
});

/** Straight westerly hodograph: speed grows linearly with height, no turning. */
function straightProfile(): WindLevel[] {
  const levels: WindLevel[] = [];
  for (let z = 0; z <= 6000; z += 250) levels.push({ heightAglM: z, u: z / 300, v: 0 });
  return levels;
}

/**
 * Hodograph turning clockwise with height: a quarter circle of radius 15 m/s
 * about the origin, from due-north-blowing at the ground to due-east-blowing
 * at 6 km. This is the classic Northern Hemisphere supercell shape, and the
 * circle must be centred on the origin — a circle centred elsewhere traces
 * the same points with the opposite sense of curvature.
 */
function clockwiseProfile(): WindLevel[] {
  const levels: WindLevel[] = [];
  for (let z = 0; z <= 6000; z += 250) {
    const angle = (Math.PI / 2) * (z / 6000);
    levels.push({ heightAglM: z, u: 15 * Math.sin(angle), v: 15 * Math.cos(angle) });
  }
  return levels;
}

describe('bulkShear and meanWind', () => {
  it('measures the vector difference across the layer', () => {
    const shear = bulkShear(straightProfile(), 0, 6000);
    expect(shear?.magnitudeMs).toBeCloseTo(20, 6);
    expect(shear?.v).toBeCloseTo(0, 6);
  });

  it('returns null outside the profile', () => {
    expect(bulkShear(straightProfile(), 0, 12_000)).toBeNull();
    expect(meanWind(straightProfile(), 9000, 12_000)).toBeNull();
  });

  it('refuses to pass off a shallow mean as a deep-layer mean', () => {
    // A profile that stops at 1.3 km has no 0-6 km mean wind. Averaging the
    // levels it does have and calling the answer "0-6 km" is the kind of
    // quiet mislabelling that makes a number worse than no number.
    const shallow = straightProfile().filter((l) => l.heightAglM <= 1300);
    expect(meanWind(shallow, 0, 6000)).toBeNull();
    expect(meanWind(shallow, 0, 1000)).not.toBeNull();
  });
});

describe('bunkersStormMotion', () => {
  it('splits the movers either side of the shear vector', () => {
    const motion = bunkersStormMotion(straightProfile());
    expect(motion).not.toBeNull();
    const { mean0to6km, right, left } = motion as NonNullable<typeof motion>;
    // Shear points due east, so the deviation is north/south of the mean.
    expect(right.u).toBeCloseTo(mean0to6km.u, 6);
    expect(left.u).toBeCloseTo(mean0to6km.u, 6);
    expect(right.v).toBeCloseTo(mean0to6km.v - 7.5, 6);
    expect(left.v).toBeCloseTo(mean0to6km.v + 7.5, 6);
    expect(Math.hypot(right.u - mean0to6km.u, right.v - mean0to6km.v)).toBeCloseTo(7.5, 6);
  });

  it('collapses both movers onto the mean wind when there is no shear', () => {
    const calm: WindLevel[] = [];
    for (let z = 0; z <= 6000; z += 500) calm.push({ heightAglM: z, u: 5, v: 5 });
    const motion = bunkersStormMotion(calm);
    expect(motion?.right).toEqual(motion?.left);
  });
});

describe('hemisphere handling', () => {
  it('names the cyclonic mover per hemisphere', () => {
    expect(hemisphereOf(-25.5)).toBe('southern');
    expect(hemisphereOf(35.2)).toBe('northern');
    expect(hemisphereOf(0)).toBe('northern');
    expect(cyclonicMover('northern')).toBe('right');
    expect(cyclonicMover('southern')).toBe('left');
  });

  it('gives clockwise curvature a positive helicity in the Northern Hemisphere', () => {
    // Curvature alone, with the storm at the origin, so the deviant-motion
    // term cannot carry the sign. A quarter circle of radius R traced
    // clockwise integrates to about R² * (pi/2) = 353 m²/s².
    const curvature = stormRelativeHelicity(clockwiseProfile(), { u: 0, v: 0 }, 6000) as number;
    expect(curvature).toBeCloseTo(15 * 15 * (Math.PI / 2), -1);
    expect(curvature).toBeGreaterThan(0);

    // The mirrored hodograph curves the other way, so the same integral is
    // negative — which is exactly why the Southern Hemisphere needs the flip.
    const mirrored = clockwiseProfile().map((l) => ({ ...l, u: -l.u }));
    expect(stormRelativeHelicity(mirrored, { u: 0, v: 0 }, 6000) as number).toBeCloseTo(
      -curvature,
      6,
    );
  });

  it('gives a mirrored hodograph the opposite helicity sign', () => {
    // This is the whole reason the Southern Hemisphere needs its own
    // treatment: the same storm, mirrored across the equator, produces an
    // SRH of the same magnitude and the opposite sign.
    const north = clockwiseProfile();
    const south = north.map((l) => ({ ...l, u: -l.u }));

    const nMotion = bunkersStormMotion(north) as NonNullable<ReturnType<typeof bunkersStormMotion>>;
    const sMotion = bunkersStormMotion(south) as NonNullable<ReturnType<typeof bunkersStormMotion>>;

    const nSrh = stormRelativeHelicity(north, nMotion.right, 3000) as number;
    const sSrh = stormRelativeHelicity(south, sMotion.left, 3000) as number;

    expect(nSrh).toBeGreaterThan(0);
    expect(sSrh).toBeLessThan(0);
    expect(Math.abs(sSrh)).toBeCloseTo(Math.abs(nSrh), 6);
  });

  it('gives a straight hodograph no helicity for a storm moving along it', () => {
    const profile = straightProfile();
    const motion = bunkersStormMotion(profile) as NonNullable<
      ReturnType<typeof bunkersStormMotion>
    >;
    expect(stormRelativeHelicity(profile, motion.mean0to6km, 3000) as number).toBeCloseTo(0, 6);

    // A deviant mover on a straight hodograph still sees helicity, and the
    // closed form says exactly how much: the 7.5 m/s offset normal to the
    // hodograph times the speed change across the layer.
    const srh = stormRelativeHelicity(profile, motion.right, 3000) as number;
    expect(srh).toBeCloseTo(7.5 * (3000 / 300 - 0), 6);
  });
});

describe('pressureAtHeight', () => {
  it('interpolates between levels instead of snapping to one', () => {
    const env = buildEnv(
      STANDARD_PRESSURES,
      (p) => 20 - 6.5 * (1000 - p) * 0.0125,
      () => 0,
    );
    const three = pressureAtHeight(env, 3000) as number;
    expect(three).not.toBeNull();
    // Strictly between the levels that bracket 3 km, not equal to either.
    const below = env.filter((l) => l.heightM <= 3000).pop() as (typeof env)[number];
    const above = env.find((l) => l.heightM >= 3000) as (typeof env)[number];
    expect(three).toBeLessThan(below.pressureHpa);
    expect(three).toBeGreaterThan(above.pressureHpa);
    // Round trip: the height at that pressure is 3 km again.
    expect(sampleEnvironment(env, three)?.heightM).toBeCloseTo(3000, 0);
  });

  it('refuses to extrapolate past either end', () => {
    const env = buildEnv(
      [1000, 900, 800],
      () => 10,
      () => 0,
    );
    expect(pressureAtHeight(env, -100)).toBeNull();
    expect(pressureAtHeight(env, 50_000)).toBeNull();
  });
});

describe('sampleEnvironment', () => {
  it('interpolates between levels and refuses to extrapolate', () => {
    const env = buildEnv(
      [1000, 900, 800],
      (p) => (p - 800) / 100,
      () => -10,
    );
    expect(sampleEnvironment(env, 950)?.temperatureC).toBeCloseTo(1.49, 1);
    expect(sampleEnvironment(env, 1010)).toBeNull();
    expect(sampleEnvironment(env, 700)).toBeNull();
  });
});
