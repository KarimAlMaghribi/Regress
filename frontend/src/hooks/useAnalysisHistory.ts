import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';

export const AnalysisResultSchema = z.object({
  id: z.number(),
  run_time: z.string(),
  file_name: z.string().nullable(),
  prompts: z.string(),
  regress: z.boolean(),
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
    try {
      setLoading(true);
      const url = `http://localhost:8084/history`;
      const res = await fetch(url);
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
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
