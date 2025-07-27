import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';

const MetricsSchema = z.object({
  accuracy: z.number(),
  cost: z.number(),
  hallucinationRate: z.number(),
}).catchall(z.any());

export const AnalysisResultSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  promptName: z.string().optional(),
  pdfFilenames: z.array(z.string()),
  runTime: z.string(),
  metrics: MetricsSchema,
  responses: z.array(z.object({ answer: z.string(), source: z.string().optional() })).optional(),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export interface HistoryOptions {
  promptId?: string;
  start?: Date;
  end?: Date;
  limit?: number;
}

export default function useAnalysisHistory(options: HistoryOptions) {
  const [data, setData] = useState<AnalysisResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 50));
    if (options.promptId) params.set('promptId', options.promptId);
    if (options.start) params.set('start', options.start.toISOString());
    if (options.end) params.set('end', options.end.toISOString());

    try {
      setLoading(true);
      const backend = import.meta.env.VITE_API_URL || 'http://localhost:8090';
      const res = await fetch(`${backend}/history?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = z.array(AnalysisResultSchema).parse(json);
      setData(parsed);
      setError(null);
    } catch (err) {
      console.error('useAnalysisHistory', err);
      setError((err as Error).message);
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [options.promptId, options.start?.toISOString(), options.end?.toISOString(), options.limit]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
