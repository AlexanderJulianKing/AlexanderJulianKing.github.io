/* Deterministic regression checks for codex-11m-predictor.html. Run with Node. */
'use strict';

const components = [
  { median: 1.8, scale: 0.50 },
  { median: 5.5, scale: 0.35 },
  { median: 9.4, scale: 0.50 }
];
const defaultWeights = [0.0475, 0.1425, 0.76, 0.05];

function normalCdf(value) {
  if (value === 0) return 0.5;
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - polynomial * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function componentCdf(component, days) {
  if (days <= 0) return 0;
  return normalCdf((Math.log(days) - Math.log(component.median)) / component.scale);
}

function distribution(elapsed = 0, weights = defaultWeights) {
  const elapsedCdfs = components.map(component => componentCdf(component, elapsed));
  const survival = components.map((_, index) => weights[index] * (1 - elapsedCdfs[index]));
  survival.push(weights[3]);
  const denominator = survival.reduce((sum, value) => sum + value, 0);

  function cdf(days) {
    if (days <= elapsed) return 0;
    return components.reduce((sum, component, index) => {
      return sum + weights[index] * (componentCdf(component, days) - elapsedCdfs[index]);
    }, 0) / denominator;
  }

  function quantile(probability) {
    const maxCdf = (survival[0] + survival[1] + survival[2]) / denominator;
    if (probability >= maxCdf) return Infinity;
    let low = elapsed;
    let high = Math.max(21, elapsed + 21);
    while (cdf(high) < probability) high *= 2;
    for (let i = 0; i < 80; i += 1) {
      const midpoint = (low + high) / 2;
      if (cdf(midpoint) < probability) low = midpoint;
      else high = midpoint;
    }
    return (low + high) / 2;
  }

  return { cdf, quantile, liveWeights: survival.map(value => value / denominator) };
}

function near(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

const lastGap = 5.5230;
const expectedLastGapCdfs = [0.987528, 0.504754, 0.143759];
components.forEach((component, index) => near(componentCdf(component, lastGap), expectedLastGapCdfs[index], 1e-5, `component ${index} CDF at last gap`));

const base = distribution();
[[2.5, 0.040158], [lastGap, 0.228093], [7, 0.365948], [10, 0.601168], [21, 0.908982]].forEach(([days, expected]) => {
  near(base.cdf(days), expected, 1e-5, `mixture CDF at ${days}d`);
});
[[0.10, 3.9376], [0.50, 8.5750], [0.80, 14.4003], [0.90, 19.9803]].forEach(([probability, expected]) => {
  near(base.quantile(probability), expected, 1e-3, `q${probability}`);
});

const atOneDay = distribution(1);
[0.042045, 0.143316, 0.764352, 0.050286].forEach((expected, index) => {
  near(atOneDay.liveWeights[index], expected, 1e-5, `e=1 live weight ${index}`);
});
near(atOneDay.quantile(0.50), 8.6116, 1e-3, 'e=1 q50');
near(atOneDay.quantile(0.90), 20.0391, 1e-3, 'e=1 q90');
near(atOneDay.cdf(3), 0.049226, 1e-5, 'e=1 cdf(3)');

const atTenDays = distribution(10);
near(atTenDays.quantile(0.50), 14.4201, 1e-3, 'e=10 q50');
near(atTenDays.cdf(12), 0.274267, 1e-5, 'e=10 cdf(12)');

if (Number.isFinite(atTenDays.quantile(0.90))) {
  throw new Error('e=10 q90 should be non-finite once the live no-post weight exceeds 10%');
}

console.log('Codex 11M model regression checks passed.');
