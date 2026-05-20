# B2B SaaS Trial-to-Paid Conversion Rate Benchmarks (2024)

This reference summarizes industry-reported conversion rates for the
trial-to-paid step in B2B SaaS funnels, drawn from publicly disclosed
operating metrics and aggregated benchmark reports.

## Headline numbers

- **Overall median**: 3.1% of free-trial signups become paying customers
  within 30 days of trial start.
- **Interquartile range (IQR)**: 2.0% to 5.0%. Companies above the 75th
  percentile typically have rate above 5.0%; companies below the 25th
  percentile have rate below 2.0%.
- **Top decile** (90th percentile): 7.5% or higher.
- **Bottom decile** (10th percentile): below 1.0%.

These figures reflect 30-day conversion. Extending the window to 60 or
90 days lifts the median by roughly 0.5-1.0 percentage points; the
distribution shape (right-skewed, long upper tail) is preserved.

## Drivers of variance

The single largest driver of cross-company variance is **product-led
growth (PLG) maturity**:

- Companies that have had a public PLG motion for less than 12 months
  cluster in the 1.0%-2.5% range. The trial UX, onboarding email
  sequence, and activation events are typically still being instrumented.
- Companies with 2+ years of PLG investment cluster in the 3.0%-5.5%
  range. By this stage they typically have an activation metric defined,
  a working in-product upgrade path, and a meaningful free-tier limit
  that prompts upgrade.
- Companies above 5.5% conversion almost universally have a usage-based
  pricing component (vs pure seat-based) and a tightly defined "aha
  moment" trigger in the first session.

Secondary drivers:

- **Trial length.** 7-day trials convert higher than 30-day trials at the
  rate level but the absolute count is lower because more users drop off
  before reaching the trial end.
- **Credit-card-required vs no-card trials.** Card-required trials show
  10-15% conversion rates but only because the funnel pre-qualifies; the
  effective top-of-funnel-to-paid number is comparable to no-card trials.
- **B2B segment.** SMB-targeted products tend to higher conversion
  (median 4.0%); mid-market and enterprise products tend lower (median
  2.0%) because the buying motion involves more stakeholders.

## Distribution shape

The conversion-rate distribution across the surveyed companies is
**right-skewed**. A symmetric model (Normal centered on the median) is
not the best fit because the upper tail extends well past the 95th
percentile while the lower tail is bounded near zero.

Suitable parametric fits:

- **Beta(alpha=2.5, beta=80)** captures the bounded-on-[0,1] shape with
  most density in the 1%-5% region and a thin upper tail.
- **Triangular(min=0.5%, mode=3.1%, max=10%)** is a planning-friendly
  approximation when the user is reasoning over best/likely/worst-case
  estimates.

A symmetric Normal(mean=3.1%, sd=1.5%) is also commonly used in
planning models and produces broadly similar central estimates but
underestimates the upper-tail mass above 6%.

## Sample size and date range

The figures above aggregate 420 companies reporting Q1-Q4 2024 metrics.
Survey methodology: self-reported KPIs collected via the SaaS
Benchmarks 2024 partner program; outliers below 0.1% and above 25% were
excluded as definitional anomalies.

## How to use this in a finESS uncertainty model

A reasonable prior for a "trial-to-paid conversion" node, absent
company-specific data, is **Beta(2.5, 80)**: mean approximately 0.030,
mode in the same 3%-range, and a 95% interval roughly [0.5%, 8%]. If the
modeling user has 2+ years of PLG history they can tighten the prior or
shift it to the right; if they're under 1 year of PLG, they should
shift it to the left and widen the spread.
