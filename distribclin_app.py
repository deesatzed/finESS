#!/usr/bin/env python3
"""
DistribClin v0.1
A self-contained demonstration app embodying the 6 principles of honest clinical uncertainty modeling.

Run: python distribclin_app.py
It will generate distribclin_demo.html — a beautiful, interactive, standalone report.

Philosophy in action:
1. Distributions, not verdicts.
2. Expert disagreement becomes variance, not error.
3. AI estimates inputs; classical math propagates uncertainty.
4. Calibration is the evaluation metric.
5. Sensitivity analysis tells clinicians what to verify next.
6. A wide interval is not failure; it is useful honesty.
"""

import os
import numpy as np
import pandas as pd
from scipy import stats
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# ============================================================
# CONFIGURATION - Easy to modify for different clinical scenarios
# ============================================================
OUTPUT_DIR = "/home/workdir/artifacts"
os.makedirs(OUTPUT_DIR, exist_ok=True)

N_SAMPLES = 12000          # Monte Carlo samples - higher = smoother distributions
RANDOM_SEED = 42

# Clinical scenario parameters (mean, sd) — all probabilities in [0,1]
# Pre-test: incorporates expert disagreement (e.g. experts gave 0.10, 0.17, 0.25)
P_PRE_MEAN = 0.18
P_PRE_SD   = 0.055

# D-dimer test characteristics (typical for PE rule-out)
SENS_MEAN = 0.93
SENS_SD   = 0.025

SPEC_MEAN = 0.38
SPEC_SD   = 0.075

THRESHOLD_HIGH_RISK = 0.30   # Example: >30% → consider imaging / further testing

# ============================================================
# HELPER FUNCTIONS
# ============================================================
def get_beta_params(mean: float, sd: float) -> tuple[float, float]:
    """Convert mean + sd to Beta(alpha, beta) parameters (robust approximation)."""
    if sd <= 0:
        sd = 1e-6
    var = sd ** 2
    # Method of moments
    alpha = mean * (mean * (1 - mean) / var - 1)
    beta  = (1 - mean) * (mean * (1 - mean) / var - 1)
    return max(alpha, 0.05), max(beta, 0.05)

def compute_posterior(pre: np.ndarray, sens: np.ndarray, spec: np.ndarray) -> np.ndarray:
    """Vectorized Bayes update for positive test result."""
    denom = pre * sens + (1 - pre) * (1 - spec)
    post = (pre * sens) / np.clip(denom, 1e-12, None)
    return np.clip(post, 0.0, 1.0)

def run_full_mc(p_pre_m=P_PRE_MEAN, p_pre_s=P_PRE_SD,
                sens_m=SENS_MEAN, sens_s=SENS_SD,
                spec_m=SPEC_MEAN, spec_s=SPEC_SD,
                n=N_SAMPLES, seed=None) -> dict:
    """Run full Monte Carlo propagation and return key statistics."""
    if seed is not None:
        np.random.seed(seed)
    a_pre, b_pre = get_beta_params(p_pre_m, p_pre_s)
    a_se,  b_se  = get_beta_params(sens_m, sens_s)
    a_sp,  b_sp  = get_beta_params(spec_m, spec_s)

    pre  = np.random.beta(a_pre, b_pre, n)
    sens = np.random.beta(a_se,  b_se,  n)
    spec = np.random.beta(a_sp,  b_sp,  n)

    post = compute_posterior(pre, sens, spec)

    ci_low, ci_high = np.percentile(post, [2.5, 97.5])
    return {
        'mean': float(np.mean(post)),
        'median': float(np.median(post)),
        'ci_low': float(ci_low),
        'ci_high': float(ci_high),
        'ci_width': float(ci_high - ci_low),
        'p_above_threshold': float(np.mean(post > THRESHOLD_HIGH_RISK)),
        'samples': post
    }

def get_input_quantiles(mean: float, sd: float, q: float = 0.10) -> tuple[float, float]:
    """Return low and high quantiles of the input Beta distribution."""
    a, b = get_beta_params(mean, sd)
    low  = stats.beta.ppf(q, a, b)
    high = stats.beta.ppf(1 - q, a, b)
    return float(low), float(high)

# ============================================================
# RUN THE MODEL
# ============================================================
np.random.seed(RANDOM_SEED)

base_stats = run_full_mc()
post_samples = base_stats['samples']

# Pre-compute input distributions for plotting
alpha_pre, beta_pre = get_beta_params(P_PRE_MEAN, P_PRE_SD)
alpha_sens, beta_sens = get_beta_params(SENS_MEAN, SENS_SD)
alpha_spec, beta_spec = get_beta_params(SPEC_MEAN, SPEC_SD)

# ============================================================
# SENSITIVITY ANALYSIS (Principle 5)
# ============================================================
param_map = {
    'Pre-test probability': ('p_pre', P_PRE_MEAN, P_PRE_SD),
    'Test Sensitivity':     ('sens', SENS_MEAN, SENS_SD),
    'Test Specificity':     ('spec', SPEC_MEAN, SPEC_SD)
}

# Tornado: one-way sensitivity on posterior MEAN
tornado_data = []
for name, (key, m, s) in param_map.items():
    low, high = get_input_quantiles(m, s, 0.10)
    if key == 'p_pre':
        stats_low  = run_full_mc(p_pre_m=low,  p_pre_s=s)
        stats_high = run_full_mc(p_pre_m=high, p_pre_s=s)
    elif key == 'sens':
        stats_low  = run_full_mc(sens_m=low,  sens_s=s)
        stats_high = run_full_mc(sens_m=high, sens_s=s)
    else:
        stats_low  = run_full_mc(spec_m=low,  spec_s=s)
        stats_high = run_full_mc(spec_m=high, spec_s=s)

    tornado_data.append({
        'param': name,
        'low_val': round(low, 3),
        'high_val': round(high, 3),
        'output_low': round(stats_low['mean'], 4),
        'output_high': round(stats_high['mean'], 4),
        'swing': round(abs(stats_high['mean'] - stats_low['mean']), 4)
    })

tornado_df = pd.DataFrame(tornado_data).sort_values('swing', ascending=True)

# "What to verify next": reduce each input SD by 50% and measure CI width reduction
verify_results = []
base_width = base_stats['ci_width']
for name, (key, m, s) in param_map.items():
    reduced_s = s * 0.5
    if key == 'p_pre':
        new_stats = run_full_mc(p_pre_m=m, p_pre_s=reduced_s)
    elif key == 'sens':
        new_stats = run_full_mc(sens_m=m, sens_s=reduced_s)
    else:
        new_stats = run_full_mc(spec_m=m, spec_s=reduced_s)

    reduction = base_width - new_stats['ci_width']
    verify_results.append({
        'param': name,
        'base_sd': round(s, 4),
        'reduced_sd': round(reduced_s, 4),
        'new_ci_width': round(new_stats['ci_width'], 4),
        'reduction': round(reduction, 4),
        'pct_reduction': round(100 * reduction / base_width, 1) if base_width > 0 else 0
    })

verify_df = pd.DataFrame(verify_results).sort_values('reduction', ascending=False)
top_priority = verify_df.iloc[0]

# ============================================================
# PLOTLY FIGURES
# ============================================================

# 1. Input distributions
fig_inputs = make_subplots(
    rows=1, cols=3,
    subplot_titles=(
        f"Pre-test Probability<br><sub>mean={P_PRE_MEAN:.0%} • sd={P_PRE_SD:.1%}<br>(expert disagreement included)</sub>",
        f"Test Sensitivity<br><sub>mean={SENS_MEAN:.0%} • sd={SENS_SD:.1%}</sub>",
        f"Test Specificity<br><sub>mean={SPEC_MEAN:.0%} • sd={SPEC_SD:.1%}</sub>"
    ),
    horizontal_spacing=0.08
)

x = np.linspace(0, 1, 250)
fig_inputs.add_trace(go.Scatter(
    x=x, y=stats.beta.pdf(x, alpha_pre, beta_pre),
    fill='tozeroy', fillcolor='rgba(14, 165, 233, 0.25)', line=dict(color='#0ea5e9', width=3),
    name='Pre-test'
), row=1, col=1)
fig_inputs.add_vline(x=P_PRE_MEAN, line_dash="dash", line_color="#0f172a", row=1, col=1)

fig_inputs.add_trace(go.Scatter(
    x=x, y=stats.beta.pdf(x, alpha_sens, beta_sens),
    fill='tozeroy', fillcolor='rgba(16, 185, 129, 0.25)', line=dict(color='#10b981', width=3),
    name='Sensitivity'
), row=1, col=2)
fig_inputs.add_vline(x=SENS_MEAN, line_dash="dash", line_color="#0f172a", row=1, col=2)

fig_inputs.add_trace(go.Scatter(
    x=x, y=stats.beta.pdf(x, alpha_spec, beta_spec),
    fill='tozeroy', fillcolor='rgba(245, 158, 11, 0.25)', line=dict(color='#f59e0b', width=3),
    name='Specificity'
), row=1, col=3)
fig_inputs.add_vline(x=SPEC_MEAN, line_dash="dash", line_color="#0f172a", row=1, col=3)

fig_inputs.update_layout(
    title="Input Parameter Distributions (Beta) — Principle 2 & 3",
    height=420, showlegend=False,
    margin=dict(t=80, b=40, l=40, r=40),
    plot_bgcolor='white'
)
fig_inputs.update_xaxes(range=[0, 1], title_text="Probability")
fig_inputs.update_yaxes(title_text="Density")

# 2. Output posterior distribution (main result)
fig_output = go.Figure()
fig_output.add_trace(go.Histogram(
    x=post_samples,
    nbinsx=60,
    marker_color='rgba(14, 165, 233, 0.75)',
    name='Posterior samples'
))
fig_output.add_vline(x=base_stats['mean'], line_color='#ef4444', line_width=4,
                     annotation_text=f"Mean {base_stats['mean']:.1%}", annotation_position="top right")
fig_output.add_vline(x=base_stats['ci_low'], line_color='#22c55e', line_dash='dash', line_width=2.5,
                     annotation_text=f"2.5% {base_stats['ci_low']:.1%}")
fig_output.add_vline(x=base_stats['ci_high'], line_color='#22c55e', line_dash='dash', line_width=2.5,
                     annotation_text=f"97.5% {base_stats['ci_high']:.1%}")
fig_output.add_vrect(x0=base_stats['ci_low'], x1=base_stats['ci_high'],
                     fillcolor="#22c55e", opacity=0.12, layer="below", line_width=0)

fig_output.update_layout(
    title=f"Posterior Probability of PE (Positive D-dimer Test)<br><span style='font-size:1.05rem'>95% Credible Interval: <b>[{base_stats['ci_low']:.1%} – {base_stats['ci_high']:.1%}]</b>  •  P(>30% risk) = <b>{base_stats['p_above_threshold']:.1%}</b></span>",
    xaxis_title="Posterior Probability of Pulmonary Embolism",
    yaxis_title="Number of Monte Carlo samples",
    height=520,
    margin=dict(t=90),
    plot_bgcolor='white'
)

# 3. Tornado plot
fig_tornado = go.Figure()
for _, row in tornado_df.iterrows():
    fig_tornado.add_trace(go.Bar(
        y=[row['param']],
        x=[row['swing']],
        orientation='h',
        marker_color='#0ea5e9',
        hovertemplate=(
            f"<b>{row['param']}</b><br>"
            f"Low value ({row['low_val']:.0%}): posterior mean = {row['output_low']:.1%}<br>"
            f"High value ({row['high_val']:.0%}): posterior mean = {row['output_high']:.1%}<br>"
            f"Swing: ±{row['swing']*100/2:.1f} percentage points<extra></extra>"
        ),
        name=row['param']
    ))
fig_tornado.update_layout(
    title="One-Way Sensitivity (Tornado): How much does the posterior mean swing when each input varies across its plausible range?",
    xaxis_title="Swing in Posterior Mean Probability",
    height=380,
    showlegend=False,
    plot_bgcolor='white'
)

# 4. "What to verify next" bar chart
colors = ['#22c55e' if p == top_priority['param'] else '#64748b' for p in verify_df['param']]
fig_verify = go.Figure(go.Bar(
    x=verify_df['param'],
    y=verify_df['pct_reduction'],
    marker_color=colors,
    text=[f"{r:.0f}%" for r in verify_df['pct_reduction']],
    textposition='outside',
    textfont=dict(size=14, color='#0f172a')
))
fig_verify.update_layout(
    title=f"<b>Principle 5 — Sensitivity Analysis</b><br>Which input should we verify first to shrink uncertainty the most?<br><span style='font-size:0.95rem; color:#64748b'>Reducing uncertainty in <b>{top_priority['param']}</b> gives the biggest payoff ({top_priority['pct_reduction']:.0f}% reduction in output CI width)</span>",
    yaxis_title="% Reduction in Output 95% CI Width",
    height=420,
    plot_bgcolor='white',
    margin=dict(t=110)
)

# 5. Calibration / Reliability diagram (simulated but realistic)
np.random.seed(123)
n_cal = 800
# Create varied predicted probabilities
pred = np.concatenate([
    np.random.beta(1.8, 7, 220),
    np.random.beta(4.5, 4.5, 360),
    np.random.beta(7, 1.8, 220)
])
# Simulate observed frequencies (slightly imperfect calibration for realism)
bin_centers = []
obs = []
for i in range(10):
    mask = (pred >= i/10) & (pred < (i+1)/10)
    if mask.sum() > 8:
        avg_p = pred[mask].mean()
        # Add small realistic miscalibration + sampling noise
        observed_rate = np.clip(avg_p + np.random.normal(0, 0.035), 0.01, 0.99)
        obs.append(observed_rate)
        bin_centers.append((i + 0.5) / 10)
    else:
        obs.append(0.5)
        bin_centers.append((i + 0.5) / 10)

fig_cal = go.Figure()
fig_cal.add_trace(go.Scatter(
    x=[0, 1], y=[0, 1],
    mode='lines', line=dict(dash='dash', color='#94a3b8', width=2),
    name='Perfect calibration'
))
fig_cal.add_trace(go.Scatter(
    x=bin_centers, y=obs,
    mode='markers+lines', marker=dict(size=11, color='#0ea5e9', line=dict(width=2, color='white')),
    line=dict(width=2.5, color='#0ea5e9'),
    name='Model performance (simulated cohort)'
))
fig_cal.update_layout(
    title="Calibration (Reliability) Diagram — Principle 4<br><span style='font-size:0.95rem'>Predicted probabilities vs. actual observed frequencies in similar patients</span>",
    xaxis_title="Mean Predicted Probability (bin)",
    yaxis_title="Observed Frequency of Event",
    height=480,
    xaxis_range=[0, 1], yaxis_range=[0, 1],
    plot_bgcolor='white'
)

# ============================================================
# BUILD THE BEAUTIFUL SELF-CONTAINED HTML REPORT
# ============================================================
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DistribClin • Distributions, Not Verdicts</title>
    <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap');
        :root {{ --primary: #0ea5e9; }}
        body {{ font-family: 'Inter', system-ui, -apple-system, sans-serif; margin:0; padding:0; background:#f8fafc; color:#0f172a; line-height:1.65; }}
        .header {{ background: linear-gradient(135deg, #0f172a 0%, #1e2937 100%); color:white; padding: 4rem 2rem 3.5rem; text-align:center; position:relative; overflow:hidden; }}
        .header::after {{ content:''; position:absolute; top:-50%; right:-20%; width:60%; height:200%; background: radial-gradient(circle, rgba(14,165,233,0.15) 0%, transparent 70%); }}
        .header h1 {{ font-family: 'Space Grotesk', system-ui; font-size: 3.8rem; font-weight:700; margin:0; letter-spacing:-0.04em; }}
        .header .tagline {{ font-size:1.35rem; opacity:0.92; max-width:620px; margin:0.8rem auto 0; font-weight:500; }}
        .container {{ max-width:1180px; margin:0 auto; padding:2.5rem 1.5rem; }}
        .section {{ background:white; border-radius:20px; padding:2.25rem 2.5rem; margin-bottom:2.25rem; box-shadow:0 10px 30px -15px rgb(15 23 42 / 0.08); border:1px solid #e2e8f0; }}
        .section h2 {{ font-size:1.65rem; margin:0 0 1.25rem 0; color:#0f172a; position:relative; padding-bottom:0.6rem; }}
        .section h2::after {{ content:''; position:absolute; bottom:0; left:0; width:65px; height:4px; background:#0ea5e9; border-radius:9999px; }}
        .philosophy-grid {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(310px, 1fr)); gap:1.35rem; }}
        .phil-card {{ background:#f8fafc; border-radius:16px; padding:1.6rem 1.75rem; border:1px solid #e0f2fe; transition:transform .2s ease, box-shadow .2s ease; }}
        .phil-card:hover {{ transform:translateY(-4px); box-shadow:0 15px 25px -12px rgb(14 165 233 / 0.15); }}
        .phil-card h3 {{ color:#0369a1; font-size:1.05rem; margin:0 0 0.6rem 0; font-weight:600; }}
        .phil-card p {{ margin:0; font-size:0.95rem; color:#475569; }}
        .highlight {{ background:#f0f9ff; border-left:6px solid #0ea5e9; padding:1.35rem 1.6rem; border-radius:12px; margin:1.6rem 0; font-size:0.98rem; }}
        .stats {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:1.1rem; margin:1.8rem 0; }}
        .stat {{ background:#f8fafc; border:1px solid #bae6fd; border-radius:14px; padding:1.15rem 1.25rem; text-align:center; }}
        .stat .value {{ font-size:2.1rem; font-weight:700; color:#0ea5e9; line-height:1; }}
        .stat .label {{ font-size:0.82rem; color:#64748b; margin-top:0.35rem; font-weight:500; }}
        .plot-container {{ margin:1.4rem 0 0.6rem; border-radius:14px; overflow:hidden; box-shadow:0 4px 15px -6px rgb(0 0 0 / 0.08); }}
        .footer {{ text-align:center; padding:3rem 1rem 2rem; color:#64748b; font-size:0.9rem; }}
        .principle-num {{ font-size:0.75rem; font-weight:700; color:#0ea5e9; letter-spacing:0.5px; }}
        .wide-honest {{ font-size:1.05rem; background:#fefce8; border:2px solid #eab308; padding:1.4rem; border-radius:14px; }}
    </style>
</head>
<body>
    <div class="header">
        <div style="max-width:820px; margin:0 auto;">
            <div style="display:inline-flex; align-items:center; gap:12px; background:rgba(255,255,255,0.1); padding:6px 18px; border-radius:9999px; margin-bottom:1.25rem;">
                <div style="width:9px; height:9px; background:#22c55e; border-radius:50%; box-shadow:0 0 0 4px rgba(34,197,94,0.3);"></div>
                <span style="font-size:0.95rem; font-weight:600; letter-spacing:0.5px;">LIVE DEMONSTRATION</span>
            </div>
            <h1>DistribClin</h1>
            <p class="tagline">Distributions, not verdicts.<br>Uncertainty as a clinical superpower.</p>
            <p style="margin-top:1.4rem; opacity:0.75; font-size:1.05rem;">The 6 principles of honest probabilistic clinical decision support — made real.</p>
        </div>
    </div>

    <div class="container">

        <!-- THE 6 PRINCIPLES -->
        <div class="section">
            <h2>The Philosophy, Now Running in Your Browser</h2>
            <div class="philosophy-grid">
                <div class="phil-card">
                    <div class="principle-num">01</div>
                    <h3>Distributions, not verdicts</h3>
                    <p>No binary "high risk / low risk". You see the <strong>entire posterior distribution</strong> — the shape, the tails, the probability mass above any threshold you care about.</p>
                </div>
                <div class="phil-card">
                    <div class="principle-num">02</div>
                    <h3>Expert disagreement = variance</h3>
                    <p>The spread between three specialists (10%, 17%, 25%) is not "error" to average away. It is explicitly encoded as <strong>input uncertainty</strong> in the pre-test probability distribution.</p>
                </div>
                <div class="phil-card">
                    <div class="principle-num">03</div>
                    <h3>AI estimates inputs.<br>Classical math propagates.</h3>
                    <p>AI or literature supplies the best point estimates + confidence. <strong>Monte Carlo + Bayes</strong> does the rest. Transparent, auditable, and mathematically rigorous.</p>
                </div>
                <div class="phil-card">
                    <div class="principle-num">04</div>
                    <h3>Calibration is the metric</h3>
                    <p>We don't optimize for AUC or accuracy. We optimize for <strong>how honestly the probabilities match reality</strong>. Reliability diagrams expose dangerous over/under-confidence.</p>
                </div>
                <div class="phil-card">
                    <div class="principle-num">05</div>
                    <h3>Sensitivity tells you what to verify next</h3>
                    <p>By simulating "what if we knew this input twice as precisely?", we rank variables by their leverage on final uncertainty. <strong>Focus clinical effort where it matters most.</strong></p>
                </div>
                <div class="phil-card">
                    <div class="principle-num">06</div>
                    <h3>A wide interval is useful honesty</h3>
                    <p>A 95% interval of 11–41% is not model failure. It is <strong>actionable information</strong>: "We need better data on specificity and pre-test probability before we can be more decisive."</p>
                </div>
            </div>
        </div>

        <!-- SCENARIO + KEY STATS -->
        <div class="section">
            <h2>Clinical Scenario: 55-year-old with suspected PE</h2>
            <p style="font-size:1.05rem; max-width:820px;">
                Moderate Wells score + positive D-dimer. What is the true posterior probability of pulmonary embolism?
            </p>

            <div class="highlight">
                <strong>Inputs with honest uncertainty (AI + literature + expert panel):</strong><br>
                • Pre-test probability: <strong>18%</strong> (sd 5.5%) — <em>expert panel: 10% / 17% / 25%</em><br>
                • D-dimer sensitivity: <strong>93%</strong> (narrow uncertainty — well validated)<br>
                • D-dimer specificity: <strong>38%</strong> (sd 7.5% — highly population-dependent)
            </div>

            <div class="stats">
                <div class="stat">
                    <div class="value">{base_stats['mean']:.1%}</div>
                    <div class="label">Mean posterior probability</div>
                </div>
                <div class="stat">
                    <div class="value">[{base_stats['ci_low']:.0%}–{base_stats['ci_high']:.0%}]</div>
                    <div class="label">95% credible interval</div>
                </div>
                <div class="stat">
                    <div class="value">{base_stats['p_above_threshold']:.0%}</div>
                    <div class="label">Probability &gt; {THRESHOLD_HIGH_RISK:.0%} risk</div>
                </div>
                <div class="stat">
                    <div class="value">{base_stats['ci_width']*100:.0f} pp</div>
                    <div class="label">Width of uncertainty</div>
                </div>
            </div>

            <div class="wide-honest">
                <strong>Principle 6 in action:</strong> This wide interval is not a bug — it is the feature. It protects the patient from overconfident decisions and tells the clinician exactly where more information will help most.
            </div>
        </div>

        <!-- INPUT DISTRIBUTIONS -->
        <div class="section">
            <h2>1. Input Distributions — Where Uncertainty Begins</h2>
            <p>The beta distributions below capture both the best current estimate <strong>and</strong> the real-world variance (including expert disagreement for pre-test probability).</p>
            <div class="plot-container" id="inputs-plot" style="height:420px;"></div>
            <script>
                var figInputs = {fig_inputs.to_json()};
                Plotly.newPlot('inputs-plot', figInputs.data, figInputs.layout, {{responsive:true, displayModeBar:false}});
            </script>
        </div>

        <!-- OUTPUT DISTRIBUTION -->
        <div class="section">
            <h2>2. Propagated Posterior Distribution — Principle 1 &amp; 3</h2>
            <p>Classical probability (Bayes) inside 12,000 Monte Carlo simulations turns uncertain inputs into an honest output distribution. No black-box neural net. Fully auditable.</p>
            <div class="plot-container" id="output-plot" style="height:520px;"></div>
            <script>
                var figOutput = {fig_output.to_json()};
                Plotly.newPlot('output-plot', figOutput.data, figOutput.layout, {{responsive:true, displayModeBar:false}});
            </script>
        </div>

        <!-- SENSITIVITY ANALYSIS -->
        <div class="section">
            <h2>3. Sensitivity Analysis — What Should We Verify Next? (Principle 5)</h2>
            <p>We asked: "If we could halve the uncertainty in just one input, which one shrinks the final credible interval the most?"</p>
            <div class="plot-container" id="verify-plot" style="height:420px;"></div>
            <script>
                var figVerify = {fig_verify.to_json()};
                Plotly.newPlot('verify-plot', figVerify.data, figVerify.layout, {{responsive:true, displayModeBar:false}});
            </script>

            <div class="highlight">
                <strong>Clinical recommendation:</strong><br>
                <strong>Next verification priority: {top_priority['param']}</strong><br>
                Halving uncertainty here reduces output CI width by <strong>{top_priority['pct_reduction']:.0f}%</strong> — the highest leverage action available.
            </div>

            <h3 style="margin:2.2rem 0 0.8rem 0; font-size:1.25rem;">One-way tornado: Posterior mean sensitivity to each input</h3>
            <div class="plot-container" id="tornado-plot" style="height:380px;"></div>
            <script>
                var figTornado = {fig_tornado.to_json()};
                Plotly.newPlot('tornado-plot', figTornado.data, figTornado.layout, {{responsive:true, displayModeBar:false}});
            </script>
        </div>

        <!-- CALIBRATION -->
        <div class="section">
            <h2>4. Calibration — The Only Metric That Matters (Principle 4)</h2>
            <p>A model can be perfectly discriminative yet clinically dangerous if its probabilities are miscalibrated. We evaluate on reliability: do 30% predictions actually occur ~30% of the time?</p>
            <div class="plot-container" id="cal-plot" style="height:480px;"></div>
            <script>
                var figCal = {fig_cal.to_json()};
                Plotly.newPlot('cal-plot', figCal.data, figCal.layout, {{responsive:true, displayModeBar:false}});
            </script>
            <p style="margin-top:1rem; font-size:0.92rem; color:#64748b;">
                In production, this diagram would be generated from thousands of real patient outcomes with known ground truth. 
                The closer the line stays to the diagonal, the more trustworthy the probabilities are for shared decision-making.
            </p>
        </div>

        <!-- CLOSING -->
        <div class="section" style="background:linear-gradient(135deg,#0f172a 0%,#1e2937 100%); color:white; text-align:center; border:none;">
            <h2 style="color:white; border:none; font-size:2rem;">This is the philosophy, made real.</h2>
            <p style="max-width:620px; margin:1.25rem auto 0; font-size:1.15rem; opacity:0.92;">
                No more hidden assumptions. No more overconfident point estimates.<br>
                <strong>Distributions. Variance. Propagation. Calibration. Sensitivity. Honesty.</strong>
            </p>
            <div style="margin-top:2.5rem; font-size:0.95rem; opacity:0.7;">
                Self-contained demo • Python + NumPy + SciPy + Plotly<br>
                Modify parameters in <code>distribclin_app.py</code> and re-run to explore any clinical scenario.
            </div>
        </div>

    </div>

    <div class="footer">
        DistribClin v0.1 • May 2026 • Built to make the 6 principles tangible for clinicians and developers
    </div>

</body>
</html>
"""

# Write the HTML file
html_path = os.path.join(OUTPUT_DIR, "distribclin_demo.html")
with open(html_path, "w", encoding="utf-8") as f:
    f.write(html)

print(f"\n✅ SUCCESS! Interactive demo generated:")
print(f"   {html_path}")
print(f"\nOpen the HTML file in any modern browser to explore the full interactive experience.")
print(f"\nYou can also edit the parameters at the top of distribclin_app.py")
print(f"and re-run to instantly generate a new report for any clinical scenario.")