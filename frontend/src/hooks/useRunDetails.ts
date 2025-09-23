import { useEffect, useMemo, useState } from "react";

declare global { interface Window { __ENV__?: any } }

/* =======================
 * Types
 * ======================= */
export type RunHeader = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "timeout" | "canceled" | "finalized";
  pipeline_id: string;
  pdf_id: number;
  overall_score: number | null;
  final_extraction: Record<string, any> | null;
  final_scores: Record<string, number> | null;
  final_decisions: Record<string, boolean> | null;
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

export type Attempt = {
  id: number;
  attempt_no: number;
  candidate_key?: string | null;            // e.g. quote
  candidate_value: any;                     // raw value or {value, source, ...}
  candidate_confidence?: number | null;
  is_final: boolean;
  source?: string | null;                   // 'llm'|'regex'|'ocr'|'rule'
  batch_no?: number | null;
  created_at?: string | null;
};

export type RunStep = {
  id: number;
  order_index: number;
  step_type: "Extraction" | "Score" | "Decision" | "Final" | "Meta";
  status: "queued" | "running" | "finalized" | "failed" | "timeout" | "canceled";
  final_key?: string | null;
  final_confidence?: number | null;         // 0..1
  final_value?: any;
  definition?: StepDefinition | null;
  attempts?: Attempt[] | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type RunDetail = {
  run: RunHeader;
  steps: RunStep[];
};

/* =======================
 * Helpers / config
 * ======================= */
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

const Q_MAX = 2.3; // Heuristik-Obergrenze für Qualitätsscore

const slug = (s?: string, fb?: string) =>
    (s?.toLowerCase().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")) || fb || "";

const normalizeVal = (v: any): string | null => {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  return s.replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "");
};

const isPlaceholder = (s: string) => {
  const t = s.toLowerCase();
  return (
      t === "nicht angegeben" ||
      t === "nicht vorhanden" ||
      t === "schadennummer" ||
      t === "versicherungsnehmer name"
  );
};

const qualityScore = (r: any, promptText?: string) => {
  let q = 0;
  const v = String(r?.value ?? "").trim();
  const quote = String(r?.source?.quote ?? "").toLowerCase();
  const bbox = r?.source?.bbox;
  const page = r?.source?.page;

  if (v && !isPlaceholder(v)) q += 1.0;
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 8) q += 0.4;                       // plausibel für IDs/Nummern
  if (/[a-zA-Zäöüß]+\s+[a-zA-Zäöüß-]+/.test(v)) q += 0.3; // plausibel für Personennamen
  if (Array.isArray(bbox) && bbox.some((n: number) => Number(n) > 0)) q += 0.2;
  if (typeof page === "number" && page > 0) q += 0.1;
  if (quote.includes("schaden") || quote.includes("schadennummer") || quote.includes("versicherungsnehmer")) q += 0.3;
  return q; // 0..~2.3
};

const combineConfidence = (votes: number, total: number, qBest: number) => {
  const pVotes = (votes + 1) / (total + 2);               // Laplace
  const pQual  = Math.min(1, Math.max(0, qBest / Q_MAX)); // 0..1
  const alpha  = Math.min(0.85, 0.55 + 0.06 * total);     // 0.61..0.85
  return +(alpha * pVotes + (1 - alpha) * pQual).toFixed(4);
};

/* =======================
 * Mappers / API
 * ======================= */
function mapRunHeader(raw: any): RunHeader {
  const id = String(raw?.run_id ?? raw?.id ?? raw?.runId ?? raw?.key ?? "unknown");
  const pipeline_id = String(raw?.pipeline_id ?? raw?.pipelineId ?? "unknown");
  const pdf_id = Number(raw?.pdf_id ?? raw?.pdfId ?? raw?.pdf ?? 0) || 0;

  const status = (raw?.status as any) ?? "completed";

  return {
    id,
    status,
    pipeline_id,
    pdf_id,
    final_extraction: (raw?.final_extraction ?? raw?.extracted) ?? null,
    final_scores: (raw?.final_scores ?? raw?.scores) ?? null,
    final_decisions: (raw?.final_decisions ?? raw?.decisions) ?? null,
    overall_score:
        typeof raw?.overall_score === "number"
            ? raw.overall_score
            : typeof raw?.overallScore === "number"
                ? raw.overallScore
                : null,
    started_at: raw?.started_at ?? raw?.startedAt ?? null,
    finished_at: raw?.finished_at ?? raw?.finishedAt ?? null,
    error: raw?.error ?? null,
  };
}

async function fetchDetailAggregated(runId: string): Promise<RunDetail> {
  const base = getHistoryBase();
  const url = `${base}/analyses/${encodeURIComponent(runId)}/detail`;
  const raw = await fetchJSON<any>(url);
  const runRaw = raw?.run ?? raw;
  const stepsRaw = raw?.steps ?? raw?.run_steps ?? [];
  const run = mapRunHeader(runRaw);

  const steps: RunStep[] = Array.isArray(stepsRaw)
      ? stepsRaw.map((s: any, idx: number) => ({
        id: Number(s?.id ?? idx + 1),
        order_index: Number(s?.order_index ?? idx),
        step_type: s?.step_type ?? "Meta",
        status: s?.status ?? "finalized",
        final_key: s?.final_key ?? null,
        final_confidence: s?.final_confidence ?? null,
        final_value: s?.final_value,
        definition: s?.definition ?? null,
        attempts: s?.attempts ?? null,
        started_at: s?.started_at ?? null,
        finished_at: s?.finished_at ?? null,
        created_at: s?.created_at ?? null,
        updated_at: s?.updated_at ?? null,
      }))
      : [];

  return { run, steps };
}

async function fetchDetailViaFallback(runId: string): Promise<RunDetail> {
  const base = getHistoryBase();

  try {
    const raw = await fetchJSON<any>(`${base}/analyses/${encodeURIComponent(runId)}`);
    const run = mapRunHeader(raw);
    return { run, steps: [] };
  } catch {}

  try {
    const list = await fetchJSON<any[]>(`${base}/analyses?run_id=${encodeURIComponent(runId)}`);
    const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (first) {
      const run = mapRunHeader(first);
      return { run, steps: [] };
    }
  } catch {}

  const err: any = new Error("Run-Detail nicht gefunden");
  err.status = 404;
  throw err;
}

async function fetchFromResults(pdfId: number): Promise<RunDetail> {
  const base = getHistoryBase();
  const raw: any = await fetchJSON(`${base}/results/${encodeURIComponent(pdfId)}`);

  const final_extraction: Record<string, any> = {};
  const steps: RunStep[] = [];
  const logList: any[] = Array.isArray(raw.log) ? raw.log : [];
  let order = 0;

  for (const l of logList) {
    const pt = String(l?.prompt_type || "");
    const promptText = l?.result?.prompt_text;
    const key =
        l?.decision_key ||
        slug(promptText, l?.prompt_id != null ? `prompt_${l.prompt_id}` : undefined) ||
        (l?.prompt_id != null ? `prompt_${l.prompt_id}` : `step_${order + 1}`);

    if (pt === "ExtractionPrompt") {
      const results: any[] = Array.isArray(l?.result?.results) ? l.result.results : [];

      // gruppieren nach normalisiertem Wert
      const groups = new Map<string, { norm: string; samples: any[]; best?: any; bestScore: number }>();
      for (const r of results) {
        const norm = normalizeVal(r?.value);
        if (!norm) continue;
        const g = groups.get(norm) || { norm, samples: [], bestScore: -Infinity };
        g.samples.push(r);
        const sc = qualityScore(r, promptText);
        if (sc > g.bestScore) { g.bestScore = sc; g.best = r; }
        groups.set(norm, g);
      }

      let chosenValue: any = null;
      let chosenSource: any = null;
      let chosenConf: number | null = null;

      if (groups.size > 0) {
        const arr = Array.from(groups.values()).map(g => ({
          ...g,
          votes: g.samples.length,
          total: results.length,
          scoreSum: g.samples.reduce((s, r) => s + qualityScore(r, promptText), 0),
        }));
        arr.sort((a, b) => b.votes - a.votes || b.scoreSum - a.scoreSum);
        const top = arr[0];
        chosenValue  = top.best?.value ?? top.samples[0]?.value ?? null;
        chosenSource = top.best?.source ?? top.samples[0]?.source ?? null;
        chosenConf   = combineConfidence(top.votes, top.total, top.bestScore);
      } else if (results.length) {
        const r0 = results.find(r => r?.value != null) ?? results[0];
        chosenValue = r0?.value ?? null;
        chosenSource = r0?.source ?? null;
        chosenConf = null;
      }

      // konsolidiertes Feld für Übersicht (mit Meta)
      final_extraction[key] = {
        value: chosenValue,
        page: chosenSource?.page ?? null,
        bbox: chosenSource?.bbox ?? null,
        quote: chosenSource?.quote ?? null,
      };

      // Step-Card: gleicher Finalwert + Confidence
      steps.push({
        id: ++order,
        order_index: l?.seq_no ?? order,
        step_type: "Extraction",
        status: "finalized",
        final_key: key,
        final_confidence: chosenConf,
        final_value: chosenValue,
        definition: { prompt_id: l?.prompt_id, prompt_type: "ExtractionPrompt", json_key: null, weight: null },
        attempts: (Array.isArray(l?.result?.results) ? l.result.results : []).slice(0, 8).map((r: any, i: number) => ({
          id: i + 1,
          attempt_no: i + 1,
          candidate_key: r?.source?.quote ?? null,
          candidate_value: { value: r?.value, source: r?.source ?? null },
          candidate_confidence: null,
          is_final: normalizeVal(r?.value) === normalizeVal(chosenValue),
          source: "llm",
          batch_no: Array.isArray(l?.result?.batches) ? 1 : null,
          created_at: null,
        })),
        created_at: null,
        updated_at: null,
      });
    } else if (pt === "ScoringPrompt") {
      const consolidated = l?.result?.consolidated;
      const scoresArr: any[] = Array.isArray(l?.result?.scores) ? l.result.scores : [];
      const finalVal = consolidated?.result ?? (scoresArr[0]?.result ?? null);

      steps.push({
        id: ++order,
        order_index: l?.seq_no ?? order,
        step_type: "Score",
        status: "finalized",
        final_key: key,
        final_confidence: null,
        final_value: finalVal,
        definition: { prompt_id: l?.prompt_id, prompt_type: "ScoringPrompt", json_key: null, weight: null },
        attempts: scoresArr.map((r: any, i: number) => ({
          id: i + 1, attempt_no: i + 1,
          candidate_key: r?.source?.quote ?? null,
          candidate_value: { result: r?.result, explanation: r?.explanation, source: r?.source ?? null },
          candidate_confidence: null, is_final: i === 0, source: "llm",
          batch_no: Array.isArray(l?.result?.batches) ? 1 : null, created_at: null
        })),
        created_at: null, updated_at: null
      });
    } else if (pt === "DecisionPrompt") {
      steps.push({
        id: ++order,
        order_index: l?.seq_no ?? order,
        step_type: "Decision",
        status: "finalized",
        final_key: key,
        final_confidence: null,
        final_value: l?.result?.consolidated?.result ?? null,
        definition: { prompt_id: l?.prompt_id, prompt_type: "DecisionPrompt", json_key: l?.decision_key ?? null, weight: null },
        attempts: null,
        created_at: null, updated_at: null
      });
    }
  }

  // final_scores aus raw.scoring (booleans → 1/0)
  const final_scores: Record<string, number> = {};
  const scList: any[] = Array.isArray(raw.scoring) ? raw.scoring : [];
  scList.forEach((s, i) => {
    const k = slug(s?.prompt_text, s?.prompt_id != null ? `score_${s.prompt_id}` : `score_${i + 1}`);
    let v: number;
    if (typeof s?.result === "boolean") v = s.result ? 1 : 0;
    else if (typeof s?.result === "number") v = s.result;
    else if (typeof s?.consolidated?.result === "boolean") v = s.consolidated.result ? 1 : 0;
    else if (typeof s?.consolidated?.result === "number") v = s.consolidated.result;
    else v = 0;
    final_scores[k] = v;
  });

  // final_decisions aus raw.decision
  const final_decisions: Record<string, boolean> = {};
  (Array.isArray(raw.decision) ? raw.decision : []).forEach((d, i) => {
    const k = d?.decision_key || slug(d?.prompt_text, d?.prompt_id != null ? `decision_${d.prompt_id}` : `decision_${i + 1}`);
    const v =
        typeof d?.result === "boolean" ? d.result :
            (typeof d?.consolidated?.result === "boolean" ? d.consolidated.result : false);
    final_decisions[k] = v;
  });

  const run: RunHeader = {
    id: String(raw.run_id ?? `pdf-${pdfId}`),
    status: "completed",
    pipeline_id: String(raw.pipeline_id ?? "unknown"),
    pdf_id: Number(raw.pdf_id ?? pdfId),
    overall_score: typeof raw.overall_score === "number" ? raw.overall_score : null,
    final_extraction: Object.keys(final_extraction).length ? final_extraction : null,
    final_scores:     Object.keys(final_scores).length     ? final_scores     : null,
    final_decisions:  Object.keys(final_decisions).length  ? final_decisions  : null,
    started_at: raw.started_at ?? null,
    finished_at: raw.finished_at ?? null,
    error: raw.error ?? null,
  };

  return { run, steps };
}

/* =======================
 * Hook
 * ======================= */
export function useRunDetails(
    runId?: string,
    opts?: { pdfId?: number; storageKey?: string }
) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  // pdfId robust herleiten, falls nicht explizit übergeben
  const derivePdfId = (): number | undefined => {
    if (typeof opts?.pdfId === "number" && Number.isFinite(opts.pdfId)) return opts.pdfId;
    if (!opts?.storageKey) return undefined;
    try {
      const raw = localStorage.getItem(opts.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.pdfId === "number") return parsed.pdfId;
      if (typeof parsed?.run?.pdf_id === "number") return parsed.run.pdf_id;
    } catch {}
    return undefined;
  };

  useEffect(() => {
    let cancel = false;
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

        // 1) Bevorzugt konsolidierten Endpoint, wenn pdfId bekannt
        if (candidatePdfId != null) {
          try {
            detail = await fetchFromResults(candidatePdfId);
          } catch {}
        }

        // 2) Aggregierte Details per runId
        if (!detail && runId) {
          try {
            detail = await fetchDetailAggregated(runId);
          } catch {}
        }

        // 3) Fallbacks
        if (!detail && runId) {
          try {
            const fb = await fetchDetailViaFallback(runId);
            const fbPdf = (fb?.run?.pdf_id as number | undefined) ?? candidatePdfId;
            if (fbPdf != null) {
              try {
                detail = await fetchFromResults(fbPdf);
              } catch {
                detail = fb;
              }
            } else {
              detail = fb;
            }
          } catch {}
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
