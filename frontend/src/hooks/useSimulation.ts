import { useState, useRef } from 'react';
import { PipelineGraph } from '../types/PipelineGraph';

export default function useSimulation(graph: PipelineGraph) {
  const [currentStep, setCurrentStep] = useState(0);
  const timer = useRef<NodeJS.Timeout | null>(null);
  const steps = graph.nodes.length;

  const play = () => {
    if (timer.current) return;
    timer.current = setInterval(() => {
      setCurrentStep(s => {
        if (s >= steps - 1) {
          clearInterval(timer.current!);
          timer.current = null;
          return s;
        }
        return s + 1;
      });
    }, 1000);
  };

  const pause = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  const next = () => setCurrentStep(s => Math.min(s + 1, steps - 1));
  const prev = () => setCurrentStep(s => Math.max(s - 1, 0));
  const reset = () => {
    pause();
    setCurrentStep(0);
  };

  return { currentStep, play, pause, next, prev, reset };
}
