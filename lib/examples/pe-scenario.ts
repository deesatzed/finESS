import type { UncertaintyGraph } from "@/lib/types";

/**
 * Pre-built PE clinical scenario — instant demo, no API call needed.
 * This is the v0.2 expert system graph with 6 nodes.
 * Runs immediately with seed=42 for reproducible results.
 */
export const PE_EXAMPLE_GRAPH: UncertaintyGraph = {
  nodes: [
    {
      id: "pre_test_base",
      name: "Base Pre-test Probability",
      description:
        "Population prevalence in similar patients. Expert panels disagree: emergency medicine literature suggests 10-15%, while pulmonology literature suggests 18-25%. This disagreement IS the uncertainty.",
      distribution: "beta",
      mean: 0.18,
      sd: 0.055,
      range: [0.05, 0.45],
      unit: "%",
      group: "pre_test",
    },
    {
      id: "patient_modifier",
      name: "Patient-specific Risk Modifier",
      description:
        "Additional risk from age (55), symptoms (chest pain + dyspnea), and Wells score components",
      distribution: "normal",
      mean: 0.04,
      sd: 0.025,
      range: [-0.05, 0.15],
      unit: "pp",
      group: "pre_test",
    },
    {
      id: "comorbidity_adjust",
      name: "Comorbidity Adjustment",
      description:
        "Effect of cancer, recent surgery, or other risk amplifiers on pre-test probability",
      distribution: "beta",
      mean: 0.06,
      sd: 0.04,
      range: [0.0, 0.2],
      unit: "%",
      group: "pre_test",
    },
    {
      id: "d_dimer_sens",
      name: "D-dimer Sensitivity",
      description: "True positive rate of the test. Well-established in literature.",
      distribution: "beta",
      mean: 0.93,
      sd: 0.025,
      range: [0.82, 0.98],
      unit: "%",
      group: "test",
    },
    {
      id: "d_dimer_spec",
      name: "D-dimer Specificity",
      description:
        "True negative rate. Highly variable across populations (20-60%)",
      distribution: "beta",
      mean: 0.38,
      sd: 0.075,
      range: [0.2, 0.6],
      unit: "%",
      group: "test",
    },
    {
      id: "lab_variability",
      name: "Lab Result Variability",
      description:
        "Uncertainty in D-dimer measurement and cutoff interpretation",
      distribution: "normal",
      mean: 0.03,
      sd: 0.02,
      range: [0.0, 0.1],
      unit: "pp",
      group: "test",
    },
  ],
  edges: [
    {
      id: "e1",
      source: "pre_test_base",
      target: "pre_test_composed",
      method: "additive",
      label: "Base prevalence",
    },
    {
      id: "e2",
      source: "patient_modifier",
      target: "pre_test_composed",
      method: "additive",
      label: "Patient-specific adjustment",
    },
    {
      id: "e3",
      source: "comorbidity_adjust",
      target: "pre_test_composed",
      method: "additive",
      label: "Comorbidity effect",
    },
    {
      id: "e4",
      source: "lab_variability",
      target: "d_dimer_spec",
      method: "subtractive",
      label: "Lab noise reduces effective specificity",
    },
    {
      id: "e5",
      source: "pre_test_composed",
      target: "output",
      method: "additive",
      label: "Composed pre-test probability",
    },
    {
      id: "e6",
      source: "d_dimer_sens",
      target: "output",
      method: "bayesian_update",
      label: "Test sensitivity for Bayes update",
    },
    {
      id: "e7",
      source: "d_dimer_spec",
      target: "output",
      method: "bayesian_update",
      label: "Test specificity for Bayes update",
    },
  ],
  outputNodeId: "output",
  threshold: 0.3,
  narration:
    "This analysis decomposes PE risk into 6 uncertainty factors. The largest source of uncertainty is the base pre-test probability \u2014 expert panels disagree significantly (10-25%), and this disagreement drives ~50% of the output variance. The second largest contributor is the comorbidity adjustment (~27%). D-dimer specificity is inherently low and variable, contributing ~10%. The most valuable next step would be a CT angiogram, which would collapse the pre-test uncertainty by providing direct imaging evidence.",
};

export const PE_EXAMPLE_QUERY =
  "I'm a 55-year-old male with chest pain and shortness of breath. My D-dimer came back elevated. What's my risk of pulmonary embolism?";
