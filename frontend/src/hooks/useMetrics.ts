import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';

export const MetricRecordSchema = z.object({
  timestamp: z.string(),
  promptId: z.string(),
  modelVersion: z.string(),
  gitCommit: z.string(),
  accuracy: z.number(),
  correctness: z.number(),
  relevance: z.number(),
  completeness: z.number(),
  hallucinationRate: z.number(),
  clarityScore: z.number(),
  formalityScore: z.number(),
  concisenessScore: z.number(),
  embeddingSimilarity: z.number(),
  avgLogprob: z.number(),
  bestOfChoice: z.string(),
  moderationFlags: z.array(z.string()),
  totalTokens: z.number(),
  cost: z.number(),
  prompt: z.string().optional(),
  input: z.string().optional(),
  responses: z.array(z.string()).optional(),
});

export type MetricRecord = z.infer<typeof MetricRecordSchema>;

export interface MetricsOptions {
  promptId?: string;
  dateRange?: { start: Date; end: Date };
  metrics?: (keyof MetricRecord)[];
  rollingAverage?: boolean;
}

export default function useMetrics(options: MetricsOptions) {
  const [data, setData] = useState<MetricRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (options.promptId) params.set('promptId', options.promptId);
    if (options.dateRange) {
      params.set('start', options.dateRange.start.toISOString());
      params.set('end', options.dateRange.end.toISOString());
    }
    if (options.metrics && options.metrics.length) {
      params.set('metrics', options.metrics.join(','));
    }
    if (options.rollingAverage) params.set('rolling', '7');

    try {
      setLoading(true);
      const res = await fetch(
        `${import.meta.env.REACT_APP_API_URL || ''}/api/metrics?${params.toString()}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = z.array(MetricRecordSchema).parse(json);
      setData(parsed);
      setError(null);
    } catch (err) {
      console.error('useMetrics', err);
      setError((err as Error).message);
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [options.promptId, options.dateRange?.start, options.dateRange?.end, JSON.stringify(options.metrics), options.rollingAverage]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
