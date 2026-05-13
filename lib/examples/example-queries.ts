/**
 * Pre-written example queries for different domains.
 * These call the AI for graph generation (not pre-built graphs).
 * Only the PE scenario has a pre-built graph for instant demo.
 */
export interface ExampleScenario {
  id: string;
  domain: string;
  title: string;
  query: string;
}

export const EXAMPLE_SCENARIOS: ExampleScenario[] = [
  {
    id: "pe_clinical",
    domain: "Clinical",
    title: "Pulmonary Embolism Risk",
    query:
      "I'm a 55-year-old male with chest pain and shortness of breath. My D-dimer came back elevated. What's my risk of pulmonary embolism?",
  },
  {
    id: "startup_valuation",
    domain: "Financial",
    title: "Startup Investment Risk",
    query:
      "I'm evaluating a Series A investment in an AI startup. They have $500K ARR growing 15% monthly, 18 months of runway, strong technical team but no moat. The round is at $20M pre-money. What's the probability this returns at least 3x in 5 years?",
  },
  {
    id: "bridge_inspection",
    domain: "Engineering",
    title: "Bridge Structural Safety",
    query:
      "We're assessing a 40-year-old concrete bridge with some visible cracking. Last inspection was 3 years ago and rated it 'fair'. Traffic load has increased 20% since original design. What's the probability of structural failure requiring emergency closure within 5 years?",
  },
  {
    id: "patent_litigation",
    domain: "Legal",
    title: "Patent Infringement Outcome",
    query:
      "We're defending against a patent infringement claim. The patent has 3 independent claims, 2 of which seem strong. We have prior art that partially invalidates claim 1. The plaintiff has won 2 of 3 recent cases in this district. What's the probability we lose at trial and owe damages?",
  },
];
