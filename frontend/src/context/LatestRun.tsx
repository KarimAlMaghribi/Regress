import React, { createContext, useContext, useState } from 'react';
import { PipelineRunResult } from '../types/pipeline';

interface Ctx {
  latestRun: PipelineRunResult | null;
  setLatestRun: (run: PipelineRunResult) => void;
}

const LatestRunContext = createContext<Ctx>({
  latestRun: null,
  setLatestRun: () => {},
});

export function LatestRunProvider({ children }: { children: React.ReactNode }) {
  const [latestRun, setLatestRun] = useState<PipelineRunResult | null>(null);
  return (
    <LatestRunContext.Provider value={{ latestRun, setLatestRun }}>
      {children}
    </LatestRunContext.Provider>
  );
}

export const useLatestRun = () => useContext(LatestRunContext);
