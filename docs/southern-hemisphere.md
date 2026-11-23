# Severe-weather parameters in the Southern Hemisphere

> English translation of [`hemisferio-sul.md`](hemisferio-sul.md), which is the original.

Nearly all severe-weather literature and software were written for the Northern
Hemisphere. Applying NH conventions to a storm in southern Brazil produces no
error at all on the screen — it produces a plausible number pointing at the
wrong storm. This document records what NimbAI does about it, what has been
verified and what still has no support.

## What the code does

**The cyclonic mover is chosen by hemisphere.** `bunkersStormMotion` always
returns both members with a geometric label: `right` is the one that deviates
clockwise from the 0–6 km shear vector and `left` the one that deviates
counterclockwise, in both hemispheres. What decides which of the two is the
cyclonic supercell — the one that carries the mesocyclone and the one that
matters for a tornado forecast — is `cyclonicMover(hemisphere)`: **right in the
north, left in the south**.

**Helicity comes out in both signs.** `stormRelativeHelicity` returns the raw
integral, with no hemisphere correction. The sounding adapter reports two
fields: `srh0to1km`/`srh0to3km` with the sign flipped south of the equator, so
that "large and positive" means the same thing in both hemispheres, and
`srh0to1kmRaw`/`srh0to3kmRaw` with the integral as it comes out. The
`signConvention` field states in text which is which, and the response always
carries this in `gaps`.

**The mean wind is an integral in height.** `meanWind` computes `(1/Δz) ∫ V dz`
by the trapezoidal rule over 100 m steps, not an arithmetic mean of samples.
Bunkers et al. (2000) specify a **non-pressure-weighted** mean.

## What was verified

**The helicity matches an external implementation.** Fixing the same storm
motion on both sides, on the Norman sounding of 1999-05-04 00Z that MetPy
distributes as `may4_sounding.txt`:

| | NimbAI | MetPy 1.7.1 | difference |
|---|---|---|---|
| SRH 0–1 km | 227.5437 | 227.4816 | 0.03% |
| SRH 0–3 km | 311.6919 | 311.6735 | 0.006% |
| 0–1 km shear | 12.8755 | 12.8739 | 0.01% |
| 0–6 km shear | 21.3544 | 21.3571 | 0.01% |

**The reflection symmetry closes exactly.** Mirroring that profile about the
equator (the north–south axis flips, the east–west does not), the southern left
mover is the mirror image of the northern right mover, and the SRH of the
cyclonic mover comes out equal and opposite: `+240.05` and `−240.05`. This is
what makes the choice of hemisphere a verifiable statement and not a
preference.

**A real SH case.** Guarapuava (Paraná, Brazil), 2025-11-07 21Z, from the Open-Meteo
pressure levels: 0–6 km shear of 30.8 m/s, reported 0–3 km SRH of 356 m²/s²
(raw −356), surface CAPE 493 J/kg, LCL 844 m. It is a significant-tornado
environment, and it is exactly the case in which not flipping the sign would
make any downstream threshold read −356 as unfavorable.

All three are pinned in tests (`packages/core/src/thermo.test.ts`), including
one that fails if the direction of the Bunkers deviation is reversed.

## Where we deliberately diverge from MetPy

MetPy's Bunkers storm motion is about 0.9 m/s from ours on the same profile.
There is only one cause: **MetPy integrates the mean wind in pressure**
(`weighted_continuous_average` divides by the pressure interval), whereas
MetPy's own docstring says "non-pressure-weighted mean wind" and Bunkers et
al. (2000) specify non-weighted. Verified numerically: the trapezoidal rule in
pressure reproduces the MetPy number, the trapezoidal rule in height
reproduces ours. MetPy
[issue #2092](https://github.com/Unidata/MetPy/issues/2092) records the intent
to use a different average in `bunkers_storm_motion`. We integrate in height.

## What has NO support

This section matters more than the previous ones.

**The sign flip is our convention, not the field's.** We looked and found no
source that documents flipping the sign or taking the absolute value of the
environmental SRH in the Southern Hemisphere. The SH literature simply
**reports the negative value as it comes out**: Rae & Dyson (2015) give Q1 of
−112 m²/s² for supercells in South Africa; Oliveira et al. (2016) give −423
(0–3 km) and −230 (0–1 km) for a left-moving cyclonic supercell in southern
Brazil, and about −150 for the Xanxerê tornado. We flip because the primary
consumer is a language model applying thresholds calibrated in the NH, and a
negative number would be read as unfavorable. It is a defensible product
choice, **it is not established practice**, and that is why the raw integral
accompanies every response.

**"Left = cyclonic in the SH" has support, but not from a journal.** The
sources we found are conference and operational ones: Rae & Dyson (2015, ECSS,
South African Weather Service), Oliveira et al. (2016, 28th Conference on
Severe Local Storms, UFSM), an NSSL case study on Sydney 1999, and the SPC
sounding help page, which qualifies the right vector as "cyclonic in northern
hemisphere". Bunkers et al. (2000) **does not mention hemisphere at any
point**.

**The 7.5 m/s deviation parameter in the SH has not been tested by anyone.**
Bunkers et al. (2024) recalibrated US left movers — which are anticyclonic —
and suggest 5.0 m/s. By symmetry, the cyclonic left mover of the SH is the
mirror of the cyclonic right mover of the NH, and therefore 7.5, not 5.0. That
is what we do. No source tests this.

**No meteorologist has reviewed this.** All the verification above is
numerical and bibliographic.

## One thing that seemed to matter and does not

Bunkers' method is reflection-symmetric: rotating the deviation in the
opposite direction merely swaps the labels of the two vectors and returns the
same pair. Hence "applying the rotation the other way round" and "applying the
same formula and reading the other mover as cyclonic" give an identical
numerical result. We chose the second because it is the one that keeps the
geometric labels stable across hemispheres.

## References

- Bunkers, M. J., B. A. Klimowski, J. W. Zeitler, R. L. Thompson, M. L. Weisman,
  2000: Predicting supercell motion using a new hodograph technique.
  *Wea. Forecasting*, **15**, 61–79.
  <https://www.weather.gov/media/unr/soo/scm/BKZTW00.pdf>
- Bunkers, M. J., 2002: Vertical wind shear associated with left-moving
  supercells. *Wea. Forecasting*, **17**, 845–855.
  <https://www.weather.gov/media/unr/soo/scm/B02a.pdf>
- Rae, K. and M. Dyson, 2015: Sounding-derived characteristics associated with
  some supercell storms over the Gauteng Province of South Africa. ECSS2015-126.
  <https://meetingorganizer.copernicus.org/ECSS2015/ECSS2015-126.pdf>
- Oliveira, M. I. et al., 2016: A left-moving, cyclonic supercell in southern
  Brazil. 28th Conf. on Severe Local Storms.
  <https://ams.confex.com/ams/28SLS/webprogram/Paper300453.html>
- SPC, vector conventions in soundings.
  <https://spc.noaa.gov/exper/soundings/help/vectors.html>
