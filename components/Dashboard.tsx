"use client";

import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
}

function Panel({ title, children, className = "" }: PanelProps) {
  return (
    <div
      className={`bg-[#0f1629] rounded-lg border border-[#1e293b] overflow-hidden flex flex-col ${className}`}
    >
      <div className="px-3 py-1.5 border-b border-[#1e293b] flex-shrink-0">
        <h3 className="text-xs font-medium text-[#64748b] uppercase tracking-wider">
          {title}
        </h3>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

interface DashboardProps {
  nodeNetwork: ReactNode;
  liveDistribution: ReactNode;
  sensitivityRadar: ReactNode;
  gaugePanel: ReactNode;
  spectrumBars: ReactNode;
  narrationStream: ReactNode;
}

export function Dashboard({
  nodeNetwork,
  liveDistribution,
  sensitivityRadar,
  gaugePanel,
  spectrumBars,
  narrationStream,
}: DashboardProps) {
  return (
    <div className="flex-1 p-2 grid grid-cols-12 grid-rows-6 gap-2 min-h-0">
      {/* Panel 1: Node Network — center, largest (cols 1-8, rows 1-4) */}
      <Panel title="Node Network" className="col-span-8 row-span-4">
        {nodeNetwork}
      </Panel>

      {/* Panel 2: Live Distribution — top right (cols 9-12, rows 1-2) */}
      <Panel title="Live Distribution" className="col-span-4 row-span-2">
        {liveDistribution}
      </Panel>

      {/* Panel 3: Sensitivity Radar — mid right (cols 9-12, rows 3-4) */}
      <Panel title="Sensitivity Analysis" className="col-span-4 row-span-2">
        {sensitivityRadar}
      </Panel>

      {/* Panel 4: Uncertainty Gauges — bottom left (cols 1-4, rows 5-6) */}
      <Panel title="Uncertainty Gauges" className="col-span-4 row-span-2">
        {gaugePanel}
      </Panel>

      {/* Panel 5: Spectrum Bars — bottom center (cols 5-8, rows 5-6) */}
      <Panel title="Spectrum Bars" className="col-span-4 row-span-2">
        {spectrumBars}
      </Panel>

      {/* Panel 6: Narration Stream — bottom right (cols 9-12, rows 5-6) */}
      <Panel title="Narration" className="col-span-4 row-span-2">
        {narrationStream}
      </Panel>
    </div>
  );
}
