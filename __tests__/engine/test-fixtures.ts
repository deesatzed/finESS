import type { UncertaintyGraph } from "@/lib/types";

/**
 * The v0.2 PE clinical scenario — 6-node expert system graph.
 * This is the golden reference test graph.
 *
 * Computation flow:
 *   pre_test_base + patient_modifier + comorbidity_adjust --> pre_test_composed (additive)
 *   lab_variability --> d_dimer_spec (subtractive, modifies specificity)
 *   pre_test_composed + d_dimer_sens + d_dimer_spec --> output (bayesian_update)
 */
export const PE_GRAPH: UncertaintyGraph = {
  nodes: [
    {
      id: "pre_test_base",
      name: "Base Pre-test Probability",
      description: "Population prevalence in similar patients",
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
      description: "Additional risk from age, Wells score, symptoms",
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
      description: "Effect of cancer, surgery, or other risk amplifiers",
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
      description: "True positive rate of the test",
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
      description: "True negative rate (variable across populations)",
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
      description: "Uncertainty in D-dimer measurement / cutoff",
      distribution: "normal",
      mean: 0.03,
      sd: 0.02,
      range: [0.0, 0.1],
      unit: "pp",
      group: "test",
    },
  ],
  edges: [
    // Pre-test composition: three nodes add up
    {
      id: "e1",
      source: "pre_test_base",
      target: "pre_test_composed",
      method: "additive",
    },
    {
      id: "e2",
      source: "patient_modifier",
      target: "pre_test_composed",
      method: "additive",
    },
    {
      id: "e3",
      source: "comorbidity_adjust",
      target: "pre_test_composed",
      method: "additive",
    },
    // Lab variability subtracts from specificity
    {
      id: "e4",
      source: "lab_variability",
      target: "d_dimer_spec",
      method: "subtractive",
    },
    // Bayesian update: pre_test_composed + sens + spec --> output
    {
      id: "e5",
      source: "pre_test_composed",
      target: "output",
      method: "additive",
    },
    {
      id: "e6",
      source: "d_dimer_sens",
      target: "output",
      method: "bayesian_update",
    },
    {
      id: "e7",
      source: "d_dimer_spec",
      target: "output",
      method: "bayesian_update",
    },
  ],
  outputNodeId: "output",
  threshold: 0.3,
};

/**
 * Golden reference values from Python v0.2 (NumPy seed=42).
 * Our TypeScript engine uses a different PRNG, so exact values differ.
 * These are used for ballpark validation (within tolerance).
 */
export const PYTHON_GOLDEN = {
  mean: 0.356782,
  ciLow: 0.200975,
  ciHigh: 0.537451,
  pAboveThreshold: 0.7368,
  ciWidth: 0.336476,
  sensitivityRanking: [
    "pre_test_base",      // 50.53%
    "comorbidity_adjust", // 27.48%
    "patient_modifier",   // 10.77%
    "d_dimer_spec",       //  9.61%
    "lab_variability",    //  0.65%
    "d_dimer_sens",       //  0.45%
  ],
};
