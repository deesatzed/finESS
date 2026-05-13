#!/usr/bin/env python3
"""
DistribClin Expert System v0.2
Probabilistic Expert System for Clinical Uncertainty

Now with explicit multi-node modeling:
- Each key factor ("node") in the clinical reasoning chain has its own probability distribution + plausible range.
- Full Monte Carlo propagation across all nodes.
- Visual node network + individual distributions.
- Per-node sensitivity analysis.

This embodies "Expert System Software methods" for uncertainty:
Nodes = atomic pieces of expert knowledge + evidence with quantified uncertainty.
Monte Carlo = joint propagation of all uncertainties.
"""

import os
import numpy as np
import pandas as pd
from scipy import stats
import plotly.graph_objects as go
from plotly.subplots import make_subplots

OUTPUT_DIR = "/home/workdir/artifacts"
os.makedirs(OUTPUT_DIR, exist_ok=True)

N_SAMPLES = 15000
RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

# ============================================================
# EXPERT SYSTEM NODE DEFINITIONS
# Each node = one source of uncertainty in the clinical thought process
# ============================================================
NODES = {
    "pre_test_base": {
        "name": "Base Pre-test Probability",
        "mean": 0.18,
        "sd": 0.055,
        "dist": "beta",
        "range": (0.05, 0.45),
        "desc": "Population prevalence in similar patients (incorporates expert panel disagreement)",
        "unit": "%"
    },
    "patient_modifier": {
        "name": "Patient-specific Risk Modifier",
        "mean": 0.04,
        "sd": 0.025,
        "dist": "normal",
        "range": (-0.05, 0.15),
        "desc": "Additional risk from age, Wells score components, symptoms",
        "unit": "pp"
    },
    "d_dimer_sens": {
        "name": "D-dimer Sensitivity",
        "mean": 0.93,
        "sd": 0.025,
        "dist": "beta",
        "range": (0.82, 0.98),
        "desc": "True positive rate of the test",
        "unit": "%"
    },
    "d_dimer_spec": {
        "name": "D-dimer Specificity",
        "mean": 0.38,
        "sd": 0.075,
        "dist": "beta",
        "range": (0.20, 0.60),
        "desc": "True negative rate (highly variable across populations)",
        "unit": "%"
    },
    "lab_variability": {
        "name": "Lab Result Variability",
        "mean": 0.03,
        "sd": 0.02,
        "dist": "normal",
        "range": (0.0, 0.10),
        "desc": "Uncertainty in D-dimer measurement / cutoff interpretation",
        "unit": "pp"
    },
    "comorbidity_adjust": {
        "name": "Comorbidity Adjustment",
        "mean": 0.06,
        "sd": 0.04,
        "dist": "beta",
        "range": (0.0, 0.20),
        "desc": "Effect of cancer, recent surgery, or other risk amplifiers on pre-test",
        "unit": "%"
    }
}

THRESHOLD = 0.30

def get_beta_params(mean, sd):
    var = sd ** 2
    alpha = mean * (mean * (1 - mean) / var - 1)
    beta = (1 - mean) * (mean * (1 - mean) / var - 1)
    return max(alpha, 0.05), max(beta, 0.05)

def sample_node(node_key, n=N_SAMPLES):
    node = NODES[node_key]
    if node["dist"] == "beta":
        a, b = get_beta_params(node["mean"], node["sd"])
        samples = np.random.beta(a, b, n)
    elif node["dist"] == "normal":
        samples = np.random.normal(node["mean"], node["sd"], n)
        # Clip to plausible range
        low, high = node["range"]
        samples = np.clip(samples, low, high)
    return samples

def compute_posterior_from_nodes(samples_dict):
    """
    Expert system computation: Combine all nodes into final posterior probability.
    This is the 'thought methodology' encoded as a function.
    """
    pre = samples_dict["pre_test_base"] + samples_dict["patient_modifier"] + samples_dict["comorbidity_adjust"]
    pre = np.clip(pre, 0.01, 0.95)
    
    sens = samples_dict["d_dimer_sens"]
    spec = samples_dict["d_dimer_spec"]
    
    # Add lab variability as noise on specificity (common real-world effect)
    spec = np.clip(spec - samples_dict["lab_variability"], 0.05, 0.95)
    
    # Bayes update for positive test
    denom = pre * sens + (1 - pre) * (1 - spec)
    post = (pre * sens) / np.clip(denom, 1e-12, None)
    return np.clip(post, 0, 1)

# ============================================================
# RUN MONTE CARLO ACROSS ALL NODES
# ============================================================
node_samples = {key: sample_node(key) for key in NODES}
post_samples = compute_posterior_from_nodes(node_samples)

base_mean = float(np.mean(post_samples))
ci_low, ci_high = np.percentile(post_samples, [2.5, 97.5])
p_above = float(np.mean(post_samples > THRESHOLD))
ci_width = ci_high - ci_low

print(f"Final Posterior Mean: {base_mean:.1%}")
print(f"95% CI: [{ci_low:.1%} – {ci_high:.1%}]")
print(f"P(> {THRESHOLD:.0%}): {p_above:.1%}")

# ============================================================
# SENSITIVITY: Node contribution to output variance
# ============================================================
def compute_node_contribution():
    contributions = {}
    base_var = np.var(post_samples)
    for key in NODES:
        # One-at-a-time: fix this node to its mean, rerun MC
        fixed_samples = node_samples.copy()
        fixed_samples[key] = np.full(N_SAMPLES, NODES[key]["mean"])
        post_fixed = compute_posterior_from_nodes(fixed_samples)
        reduced_var = np.var(post_fixed)
        reduction = (base_var - reduced_var) / base_var * 100
        contributions[key] = max(0, reduction)
    return contributions

node_contrib = compute_node_contribution()
sorted_nodes = sorted(node_contrib.items(), key=lambda x: x[1], reverse=True)

# ============================================================
# PLOTS
# ============================================================

# 1. Node Network Diagram (simple expert system flowchart)
fig_network = go.Figure()
node_positions = {
    "pre_test_base": (0.2, 0.7),
    "patient_modifier": (0.2, 0.4),
    "comorbidity_adjust": (0.2, 0.1),
    "d_dimer_sens": (0.65, 0.75),
    "d_dimer_spec": (0.65, 0.45),
    "lab_variability": (0.65, 0.15),
    "final": (0.9, 0.5)
}

# Draw nodes
for key, (x, y) in node_positions.items():
    if key == "final":
        fig_network.add_trace(go.Scatter(
            x=[x], y=[y], mode='markers+text',
            marker=dict(size=45, color='#ef4444', symbol='diamond'),
            text=["FINAL<br>POSTERIOR"], textposition="middle center",
            textfont=dict(color="white", size=11, family="Inter"),
            hoverinfo="skip"
        ))
    else:
        node = NODES[key]
        fig_network.add_trace(go.Scatter(
            x=[x], y=[y], mode='markers+text',
            marker=dict(size=38, color='#0ea5e9'),
            text=[node["name"].replace(" ", "<br>")], textposition="middle center",
            textfont=dict(color="white", size=9),
            hovertext=f"{node['desc']}<br>Mean: {node['mean']:.2f} | SD: {node['sd']:.3f}",
            hoverinfo="text"
        ))

# Draw arrows (simplified)
arrows = [
    ("pre_test_base", "final"), ("patient_modifier", "final"), ("comorbidity_adjust", "final"),
    ("d_dimer_sens", "final"), ("d_dimer_spec", "final"), ("lab_variability", "final")
]
for start, end in arrows:
    fig_network.add_annotation(
        x=node_positions[end][0]-0.05, y=node_positions[end][1],
        ax=node_positions[start][0]+0.05, ay=node_positions[start][1],
        xref="x", yref="y", axref="x", ayref="y",
        arrowhead=2, arrowsize=1.2, arrowwidth=2, arrowcolor="#64748b"
    )

fig_network.update_layout(
    title="Expert System Node Network — Clinical Uncertainty Thought Process",
    xaxis=dict(range=[0, 1.1], showgrid=False, zeroline=False, showticklabels=False),
    yaxis=dict(range=[-0.1, 0.9], showgrid=False, zeroline=False, showticklabels=False),
    height=520, plot_bgcolor="white", showlegend=False
)

# 2. Individual Node Distributions (6 subplots)
fig_nodes = make_subplots(rows=2, cols=3, subplot_titles=[NODES[k]["name"] for k in NODES], horizontal_spacing=0.08, vertical_spacing=0.12)

for i, key in enumerate(NODES):
    row = i // 3 + 1
    col = i % 3 + 1
    node = NODES[key]
    samples = node_samples[key]
    
    if node["dist"] == "beta":
        x = np.linspace(0, 1, 200)
        a, b = get_beta_params(node["mean"], node["sd"])
        y = stats.beta.pdf(x, a, b)
    else:
        x = np.linspace(node["range"][0], node["range"][1], 200)
        y = stats.norm.pdf(x, node["mean"], node["sd"])
    
    fig_nodes.add_trace(go.Scatter(x=x, y=y, fill='tozeroy', line=dict(color='#0ea5e9', width=2.5),
                                    fillcolor='rgba(14,165,233,0.2)'), row=row, col=col)
    fig_nodes.add_vline(x=node["mean"], line_dash="dash", line_color="#ef4444", row=row, col=col)
    
    # Add range annotation
    low, high = np.percentile(samples, [2.5, 97.5])
    fig_nodes.add_annotation(x=0.5, y=0.92, text=f"95% range: [{low:.2f}–{high:.2f}]", 
                             showarrow=False, xref=f"x{i+1}", yref=f"y{i+1}", font=dict(size=9))

fig_nodes.update_layout(title="Individual Node Distributions — Each Source of Uncertainty", height=620, showlegend=False)

# 3. Final Posterior (same style as before but updated)
fig_output = go.Figure()
fig_output.add_trace(go.Histogram(x=post_samples, nbinsx=70, marker_color='rgba(14,165,233,0.75)'))
fig_output.add_vline(x=base_mean, line_color='#ef4444', line_width=4, annotation_text=f"Mean {base_mean:.1%}")
fig_output.add_vline(x=ci_low, line_color='#22c55e', line_dash='dash', line_width=2.5)
fig_output.add_vline(x=ci_high, line_color='#22c55e', line_dash='dash', line_width=2.5)
fig_output.add_vrect(x0=ci_low, x1=ci_high, fillcolor="#22c55e", opacity=0.12, layer="below", line_width=0)
fig_output.update_layout(
    title=f"Final Posterior Probability (All Nodes Propagated)<br>95% CI: [{ci_low:.1%} – {ci_high:.1%}] • P(>{THRESHOLD:.0%}) = {p_above:.1%}",
    xaxis_title="Posterior Probability of PE",
    yaxis_title="Monte Carlo Samples",
    height=520
)

# 4. Node Contribution Bar (Sensitivity)
fig_contrib = go.Figure(go.Bar(
    x=[NODES[k]["name"] for k, _ in sorted_nodes],
    y=[v for _, v in sorted_nodes],
    marker_color=['#22c55e' if v == max(node_contrib.values()) else '#64748b' for _, v in sorted_nodes],
    text=[f"{v:.1f}%" for _, v in sorted_nodes],
    textposition='outside'
))
fig_contrib.update_layout(
    title="Node Contribution to Output Uncertainty<br><span style='font-size:0.9rem'>Which nodes drive the most variance? (Higher = higher priority to reduce uncertainty)</span>",
    yaxis_title="% Reduction in Output Variance if Node Fixed to Mean",
    height=450
)

# ============================================================
# BUILD ENHANCED HTML
# ============================================================
html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>DistribClin Expert System v0.2 • Multi-Node Uncertainty</title>
    <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap');
        body {{ font-family: 'Inter', system-ui, sans-serif; background: #f8fafc; color: #0f172a; margin:0; padding:0; line-height:1.6; }}
        .header {{ background: linear-gradient(135deg, #0f172a, #1e2937); color:white; padding:3.5rem 2rem; text-align:center; }}
        .header h1 {{ font-family: 'Space Grotesk', sans-serif; font-size:3.4rem; margin:0; font-weight:700; }}
        .container {{ max-width:1200px; margin:0 auto; padding:2rem; }}
        .section {{ background:white; border-radius:18px; padding:2.2rem; margin-bottom:2rem; box-shadow:0 10px 25px -12px rgb(15 23 42 / 0.08); border:1px solid #e2e8f0; }}
        .section h2 {{ color:#0f172a; border-bottom:4px solid #0ea5e9; padding-bottom:0.6rem; margin-top:0; }}
        .node-table {{ width:100%; border-collapse:collapse; margin:1.5rem 0; font-size:0.95rem; }}
        .node-table th, .node-table td {{ padding:0.85rem 1rem; text-align:left; border-bottom:1px solid #e2e8f0; }}
        .node-table th {{ background:#f1f5f9; font-weight:600; color:#0f172a; }}
        .highlight {{ background:#f0f9ff; border-left:6px solid #0ea5e9; padding:1.4rem; border-radius:12px; }}
        .stats {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:1rem; margin:1.5rem 0; }}
        .stat {{ background:#f8fafc; border:1px solid #bae6fd; border-radius:14px; padding:1.1rem; text-align:center; }}
        .stat .value {{ font-size:1.9rem; font-weight:700; color:#0ea5e9; }}
        .stat .label {{ font-size:0.82rem; color:#64748b; margin-top:0.3rem; }}
    </style>
</head>
<body>
    <div class="header">
        <h1>DistribClin Expert System</h1>
        <p style="font-size:1.25rem; opacity:0.9; max-width:700px; margin:1rem auto 0;">
            Multi-Node Probabilistic Expert System<br>
            Every source of clinical uncertainty modeled explicitly
        </p>
    </div>

    <div class="container">

        <div class="section">
            <h2>Expert System Methodology — 6 Uncertainty Nodes</h2>
            <p>Instead of a single "pre-test probability", we break clinical reasoning into <strong>atomic nodes</strong> — each representing a distinct piece of expert knowledge or evidence with its own quantified uncertainty.</p>
            
            <table class="node-table">
                <tr>
                    <th>Node</th>
                    <th>Distribution</th>
                    <th>Mean</th>
                    <th>95% Range</th>
                    <th>Description</th>
                </tr>
                {''.join([f'''
                <tr>
                    <td><strong>{NODES[k]["name"]}</strong></td>
                    <td>{NODES[k]["dist"].upper()}</td>
                    <td>{NODES[k]["mean"]:.2f}</td>
                    <td>[{np.percentile(node_samples[k], 2.5):.2f} – {np.percentile(node_samples[k], 97.5):.2f}]</td>
                    <td>{NODES[k]["desc"]}</td>
                </tr>''' for k in NODES])}
            </table>
            
            <div class="highlight">
                <strong>Monte Carlo Propagation:</strong> All 6 nodes are sampled jointly (15,000 simulations). The final posterior is computed by feeding every combination through the clinical reasoning function (Bayes update + patient modifiers + comorbidity + lab variability).
            </div>
        </div>

        <div class="section">
            <h2>Node Network — The Clinical Thought Process</h2>
            <p>This diagram shows how the expert system connects the nodes. Arrows represent information flow into the final probability calculation.</p>
            <div id="network-plot" style="height:520px;"></div>
            <script>
                var figNet = {fig_network.to_json()};
                Plotly.newPlot('network-plot', figNet.data, figNet.layout, {{responsive:true}});
            </script>
        </div>

        <div class="section">
            <h2>Individual Node Distributions</h2>
            <p>Each node has its own probability distribution and plausible range — the foundation of honest expert system modeling.</p>
            <div id="nodes-plot" style="height:620px;"></div>
            <script>
                var figNodes = {fig_nodes.to_json()};
                Plotly.newPlot('nodes-plot', figNodes.data, figNodes.layout, {{responsive:true}});
            </script>
        </div>

        <div class="section">
            <h2>Final Output Distribution (All Nodes Combined)</h2>
            <div class="stats">
                <div class="stat"><div class="value">{base_mean:.1%}</div><div class="label">Mean Posterior</div></div>
                <div class="stat"><div class="value">[{ci_low:.0%}–{ci_high:.0%}]</div><div class="label">95% Credible Interval</div></div>
                <div class="stat"><div class="value">{p_above:.0%}</div><div class="label">P(&gt;{THRESHOLD:.0%} risk)</div></div>
                <div class="stat"><div class="value">{ci_width*100:.0f} pp</div><div class="label">Uncertainty Width</div></div>
            </div>
            <div id="output-plot" style="height:520px;"></div>
            <script>
                var figOut = {fig_output.to_json()};
                Plotly.newPlot('output-plot', figOut.data, figOut.layout, {{responsive:true}});
            </script>
        </div>

        <div class="section">
            <h2>Sensitivity: Which Nodes Drive Uncertainty Most?</h2>
            <p>By fixing each node to its mean value one at a time, we measure how much the output variance shrinks. This tells clinicians exactly which piece of information to prioritize next.</p>
            <div id="contrib-plot" style="height:450px;"></div>
            <script>
                var figContrib = {fig_contrib.to_json()};
                Plotly.newPlot('contrib-plot', figContrib.data, figContrib.layout, {{responsive:true}});
            </script>
            <div class="highlight" style="margin-top:1.5rem;">
                <strong>Top priority node:</strong> {NODES[sorted_nodes[0][0]]["name"]} — reducing uncertainty here has the largest impact on the final credible interval.
            </div>
        </div>

        <div class="section" style="background:#0f172a; color:white; text-align:center;">
            <h2 style="color:white; border:none;">Expert System + Monte Carlo = Honest Clinical AI</h2>
            <p style="max-width:620px; margin:1.2rem auto 0; font-size:1.1rem; opacity:0.9;">
                Every node is explicit. Every distribution is visible. Every uncertainty is propagated.<br>
                This is how expert systems should work in the age of probabilistic reasoning.
            </p>
        </div>

    </div>
</body>
</html>
"""

html_path = os.path.join(OUTPUT_DIR, "distribclin_expert_system_demo.html")
with open(html_path, "w", encoding="utf-8") as f:
    f.write(html)

print(f"\n✅ Enhanced Expert System demo created: {html_path}")
print("Open the new HTML to see the full multi-node network and individual distributions.")