import { useEffect, useMemo, useState } from "react";

export type RunHeader = {
  id: string;
  status: "queued"|"running"|"completed"|"failed"|"timeout"|"canceled";
  pipeline_id: string;
  pdf_id: number;
  overall_score: number | null;
  final_scores: Record<string, number> | null;
  final_decisions: Record<string, boolean> | null;
  final_extraction: Record<string, unknown> | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
};

export type RunStep = {
  id: number;
  order_index: number;      // kommt via Join/Definition im Backend-Detail-Endpoint; sonst clientseitig joinen
  step_type: "Extraction"|"Score"|"Decision"|"Final"|"Meta";
  status: "queued"|"running"|"finalized"|"failed";
  final_key?: string | null;
  final_confidence?: number | null;
  final_value?: unknown;    // z.B. { bool: true } oder { text: "..." }
  started_at?: string | null;
  finished_at?: string | null;
  definition?: {
    aggregator?: "MAX_CONFIDENCE"|"MAJORITY"|"WEIGHTED_SCORE"|"RULE_BASED";
    min_confidence?: number;
    decision_threshold?: number | null;
    multishot?: number;
    json_key?: string | null;
  };
};

export type Attempt = {
  id: number;
  attempt_no: number;
  candidate_key?: string | null;
  candidate_value: unknown;
  candidate_confidence?: number | null;
  is_final: boolean;
  source?: string | null;   // 'llm'|'regex'|'ocr'|'rule'
  batch_no?: number | null;
  created_at?: string | null;
};

export type RunDetail = {
  run: RunHeader;
  steps: Array<RunStep & { attempts: Attempt[] }>;
  timeline?: Array<{
    event_time: string;
    event_type: string;
    step_index?: number | null;
    status?: string | null;
    message?: string | null;
    route_stack?: string[] | null;
  }>;
  pdf?: { filename?: string; size_bytes?: number; sha256?: string; };
};

const HIST = import.meta.env.VITE_HISTORY_URL?.replace(/\/+$/, "") || "/hist";

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json() as Promise<T>;
}

async function fetchDetailAggregated(runId: string): Promise<RunDetail> {
  return fetchJSON<RunDetail>(`${HIST}/analyses/${encodeURIComponent(runId)}/detail`);
}

async function fetchDetailViaFallback(runId: string): Promise<RunDetail> {
  const run = await fetchJSON<RunHeader>(`${HIST}/analyses/${encodeURIComponent(runId)}`);
  const steps = await fetchJSON<RunStep[]>(`${HIST}/analyses/${encodeURIComponent(runId)}/steps`);
  const withAttempts = await Promise.all(
      steps.map(async (s) => {
        const attempts = await fetchJSON<Attempt[]>(
            `${HIST}/analyses/${encodeURIComponent(runId)}/steps/${s.id}/attempts`
        );
        return { ...s, attempts };
      })
  );
  // Timeline & PDF sind optional – nur laden, wenn deine API sie anbietet:
  let timeline: RunDetail["timeline"] = undefined;
  try { timeline = await fetchJSON<any[]>(`${HIST}/analyses/${encodeURIComponent(runId)}/timeline`); } catch {}
  let pdf: RunDetail["pdf"] = undefined;
  try { pdf = await fetchJSON<RunDetail["pdf"]>(`${HIST}/analyses/${encodeURIComponent(runId)}/pdf`); } catch {}
  return { run, steps: withAttempts, timeline, pdf };
}

export function useRunDetails(runId?: string) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancel = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        let detail: RunDetail;
        try {
          detail = await fetchDetailAggregated(runId);
        } catch {
          detail = await fetchDetailViaFallback(runId);
        }
        if (!cancel) setData(detail);
      } catch (e: any) {
        if (!cancel) setErr(e);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [runId]);

  const scoreSum = useMemo(() => {
    const fs = data?.run.final_scores;
    if (!fs) return 0;
    return Object.values(fs).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  }, [data]);

  return { data, loading, error: err, scoreSum };
}
