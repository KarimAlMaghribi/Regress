import { useEffect, useMemo, useState } from "react";

declare global { interface Window { __ENV__?: any } }

/** =========================
 *  Types
 *  ========================= */
export type RunHeader = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "timeout" | "canceled";
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

export type StepDefinition = {
  id?: number;
  prompt_id?: number;
  prompt_type?: "ExtractionPrompt" | "ScoringPrompt" | "DecisionPrompt" | "FinalPrompt" | "MetaPrompt";
  json_key?: string | null;
  weight?: number | null;
};

export type RunStep = {
  id: number;
  order_index: number;
  step_type: "Extraction" | "Score" | "Decision" | "Final" | "Meta";
  status: "queued" | "running" | "finalized" | "failed";
  final_key?: string | null;
  final_confidence?: number | null;
  final_value?: unknown;
  definition?: StepDefinition | null;
  attempts?: Attempt[] | null;
  created_at?: string | null;
  updated_at?: string | null;
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
  steps: RunStep[];
};

/** =========================
 *  Config / utils
 *  ========================= */
function getHistoryBase(): string {
  const w = (window as any);
  return w.__ENV__?.HISTORY_URL || (import.meta as any)?.env?.VITE_HISTORY_URL || "/hist";
}

async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err: any = new Error(`HTTP ${res.status} for ${url}: ${txt || res.statusText}`);
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  return res.json() as Promise<T>;
}

function toNumber(x: any, fallback: number = 0): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/** =========================
 *  Mappers
 *  ========================= */
function mapRunHeader(raw: any): RunHeader {
  const id = String(raw?.run_id ?? raw?.id ?? raw?.runId ?? raw?.key ?? "unknown");
  const pipeline_id = String(raw?.pipeline_id ?? raw?.pipelineId ?? "unknown");
  const pdf_id = toNumber(raw?.pdf_id ?? raw?.pdfId ?? raw?.pdf ?? 0, 0);

  const final_extraction =
      (raw?.final_extraction as any) ??
      (raw?.extracted as any) ??
      null;

  const final_scores =
      (raw?.final_scores as any) ??
      (raw?.scores as any) ??
      null;

  const final_decisions =
      (raw?.final_decisions as any) ??
      (raw?.decisions as any) ??
      null;

  const overall_score =
      (typeof raw?.overall_score === "number" ? raw.overall_score :
          typeof raw?.overallScore === "number" ? raw.overallScore :
              null);

  const status = (raw?.status as any) ?? "completed";

  return {
    id,
    status,
    pipeline_id,
    pdf_id,
    final_extraction,
    final_scores,
    final_decisions,
    overall_score,
    started_at: raw?.started_at ?? raw?.startedAt ?? null,
    finished_at: raw?.finished_at ?? raw?.finishedAt ?? null,
    error: raw?.error ?? null,
  };
}

function mapRunStep(raw: any, idx: number): RunStep {
  const def: StepDefinition | null = raw?.definition ?? {
    prompt_id: raw?.prompt_id ?? raw?.promptId,
    prompt_type: raw?.prompt_type ?? raw?.promptType,
    json_key: raw?.json_key ?? raw?.jsonKey ?? null,
    weight: raw?.weight ?? null,
  };

  return {
    id: toNumber(raw?.id ?? idx, idx),
    order_index: toNumber(raw?.order_index ?? raw?.orderIndex ?? idx, idx),
    step_type: raw?.step_type ?? raw?.stepType ?? "Meta",
    status: raw?.status ?? "finalized",
    final_key: raw?.final_key ?? raw?.finalKey ?? null,
    final_confidence: typeof raw?.final_confidence === "number" ? raw.final_confidence : (typeof raw?.finalConfidence === "number" ? raw.finalConfidence : null),
    final_value: (raw?.final_value ?? raw?.finalValue),
    definition: def,
    attempts: Array.isArray(raw?.attempts) ? raw.attempts : null,
    created_at: raw?.created_at ?? null,
    updated_at: raw?.updated_at ?? null,
  };
}

/** =========================
 *  API calls
 *  ========================= */
async function fetchDetailAggregated(runId: string): Promise<RunDetail> {
  const base = getHistoryBase();
  const url = `${base}/analyses/${encodeURIComponent(runId)}/detail`;
  const raw = await fetchJSON<any>(url);

  // expected shape: { run: {...}, steps: [...] }
  const runRaw = raw?.run ?? raw;
  const stepsRaw = raw?.steps ?? raw?.run_steps ?? [];

  const run = mapRunHeader(runRaw);
  const steps = Array.isArray(stepsRaw) ? stepsRaw.map(mapRunStep) : [];
  return { run, steps };
}

async function fetchDetailViaFallback(runId: string): Promise<RunDetail> {
  const base = getHistoryBase();

  // Try plain /analyses/{id}
  try {
    const raw = await fetchJSON<any>(`${base}/analyses/${encodeURIComponent(runId)}`);
    const run = mapRunHeader(raw);
    return { run, steps: [] };
  } catch {
    // continue
  }

  // Try list search /analyses?run_id={id}
  try {
    const list = await fetchJSON<any[]>(`${base}/analyses?run_id=${encodeURIComponent(runId)}`);
    const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (first) {
      const run = mapRunHeader(first);
      return { run, steps: [] };
    }
  } catch {
    // continue
  }

  const err: any = new Error("Run-Detail nicht gefunden");
  err.status = 404;
  throw err;
}

async function fetchFromResults(pdfId: number): Promise<RunDetail> {
  const base = getHistoryBase();
  const raw = await fetchJSON<any>(`${base}/results/${encodeURIComponent(pdfId)}`);
  const run = mapRunHeader({ ...raw, pdf_id: raw?.pdf_id ?? pdfId });
  return { run, steps: [] }; // results-Endpoint hat (vorerst) keine Steps
}

/** =========================
 *  Hook
 *  ========================= */
export function useRunDetails(
    runId?: string,
    opts?: { pdfId?: number; storageKey?: string }
) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  // pdfId aus opts oder notfalls aus localStorage lesen
  function derivePdfId(): number | undefined {
    if (typeof opts?.pdfId === "number" && Number.isFinite(opts.pdfId)) return opts.pdfId;
    if (!opts?.storageKey) return undefined;
    try {
      const raw = localStorage.getItem(opts.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.pdfId === "number") return parsed.pdfId;
      if (typeof parsed?.run?.pdf_id === "number") return parsed.run.pdf_id;
    } catch { /* ignore */ }
    return undefined;
  }

  useEffect(() => {
    let cancel = false;

    // gar keine Identifikatoren → Fehler
    const candidatePdfId = derivePdfId();
    if (!runId && candidatePdfId == null) {
      setData(null);
      setErr(new Error("Es wurde weder run_id noch pdf_id übergeben."));
      return;
    }

    setLoading(true);
    setErr(null);

    (async () => {
      try {
        let detail: RunDetail | null = null;

        // 1) Bevorzugt über runId (falls vorhanden)
        if (runId) {
          try {
            detail = await fetchDetailAggregated(runId);
          } catch {
            try {
              detail = await fetchDetailViaFallback(runId);
            } catch {
              // weiter unten versuchen wir pdfId
            }
          }
        }

        // 2) Wenn noch nichts da: Fallback über /results/{pdf_id}
        if (!detail && candidatePdfId != null) {
          detail = await fetchFromResults(candidatePdfId);
        }

        if (!detail) {
          const e: any = new Error("Keine Details gefunden");
          e.status = 404;
          throw e;
        }

        if (!cancel) setData(detail);
      } catch (e: any) {
        if (!cancel) setErr(e);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();

    return () => { cancel = true; };
  }, [runId, opts?.pdfId, opts?.storageKey]);

  const scoreSum = useMemo(() => {
    const fs = data?.run.final_scores;
    if (!fs) return 0;
    return Object.values(fs).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  }, [data]);

  return { data, loading, error: err, scoreSum };
}
