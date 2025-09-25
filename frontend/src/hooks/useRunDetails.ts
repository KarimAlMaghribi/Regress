// src/hooks/useRunDetails.ts
import * as React from "react";

/* ============================== Types ============================== */

export type StepType = "Extraction" | "Decision" | "Score";

export interface Attempt {
  id?: number | string;
  attempt_no?: number;
  candidate_key?: string;
  candidate_value?: any; // string | boolean | { value: any; page?: number; source?: { page?: number; quote?: string } }
  candidate_confidence?: number | null;
  source?: string | null;
  is_final?: boolean;
}

export interface RunStep {
  id: number;
  step_type: StepType;
  status?: "queued" | "running" | "finalized" | "completed" | "failed" | "timeout" | "canceled";
  order_index?: number;
  definition?: { json_key?: string } | null;

  final_key?: string | null;
  final_value?: any;
  final_confidence?: number | null;
  started_at?: string | null;
  finished_at?: string | null;

  attempts?: Attempt[];
}

export interface RunCore {
  id: string;
  pipeline_id?: string | null;
  pdf_id?: number | null;
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  overall_score?: number | null;
  error?: string | null;

  final_extraction?: Record<string, any>;
  final_decisions?: Record<string, boolean>;
  final_scores?: Record<string, number>;
}

export interface RunDetail {
  run: RunCore;
  steps: RunStep[];
  raw?: any; // Rohdaten für Debug
}

/* ============================== Hook ============================== */

export function useRunDetails(
    runId?: string | null,
    opts?: { pdfId?: number; storageKey?: string }
) {
  const [data, setData] = React.useState<RunDetail | undefined>();
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<Error | undefined>();

  React.useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const HIST = getHistoryBase();

        // Robust nur JSON parsen; HTML-Fallback ignorieren
        const tryFetchJson = async (url: string): Promise<any | undefined> => {
          try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) return undefined;
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) return await res.json();
            const text = await res.text();
            if (!text || text.trim().startsWith("<")) return undefined;
            try { return JSON.parse(text); } catch { return undefined; }
          } catch { return undefined; }
        };

        // pdfId herleiten
        let candidatePdfId: number | undefined = opts?.pdfId;
        if (!candidatePdfId && opts?.storageKey) {
          try {
            const raw = localStorage.getItem(opts.storageKey);
            if (raw) {
              const parsed = JSON.parse(raw);
              candidatePdfId =
                  typeof parsed?.pdfId === "number"
                      ? parsed.pdfId
                      : typeof parsed?.run?.pdf_id === "number"
                          ? parsed.run.pdf_id
                          : undefined;
            }
          } catch { /* ignore */ }
        }

        // 1) /hist/results/{pdf_id}
        let payload: any | undefined = undefined;
        if (candidatePdfId != null) {
          payload = await tryFetchJson(`${HIST}/results/${encodeURIComponent(candidatePdfId)}`);
        }

        // 2) analyses?run_id → results/{pdf_id}
        if (!payload && runId) {
          const list = await tryFetchJson(`${HIST}/analyses?run_id=${encodeURIComponent(runId)}`);
          const first = Array.isArray(list) && list.length ? list[0] : undefined;
          const fromListPdf = Number(first?.pdf_id);
          if (Number.isFinite(fromListPdf)) {
            payload = await tryFetchJson(`${HIST}/results/${encodeURIComponent(fromListPdf)}`);
          }
        }

        // 3) analyses/{id}/detail
        if (!payload && runId) {
          payload = await tryFetchJson(`${HIST}/analyses/${encodeURIComponent(runId)}/detail`);
        }

        // 4) Fallback LocalStorage
        if (!payload && opts?.storageKey) {
          try {
            const raw = localStorage.getItem(opts.storageKey);
            if (raw) {
              const parsed = JSON.parse(raw);
              payload = parsed?.run ?? parsed;
            }
          } catch { /* ignore */ }
        }

        if (!payload) throw new Error("Keine Run-Daten als JSON gefunden. (Die angefragten Endpunkte liefern HTML oder 4xx.)");

        const normalized = toRunDetail(payload);
        if (!alive) return;
        setData(normalized);

        try {
          if (opts?.storageKey) {
            localStorage.setItem(
                opts.storageKey,
                JSON.stringify({ pdfId: normalized.run.pdf_id, run: normalized.run })
            );
          }
        } catch { /* ignore */ }

        setLoading(false);
      } catch (e: any) {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [runId, opts?.pdfId, opts?.storageKey]);

  // Summe der Scores (für die Seitenkarte)
  const scoreSum = React.useMemo(() => {
    if (!data?.run?.final_scores) return 0;
    return Object.values(data.run.final_scores).reduce(
        (acc, n) => acc + (typeof n === "number" ? n : 0),
        0
    );
  }, [data?.run?.final_scores]);

  return { data, loading, error, scoreSum };
}

/* ============================== Konsolidierung & Utils ============================== */

// Stoppliste / Normalisierung
const STOP_VALUES = new Set<string>([
  "", "-", "–", "—",
  "schadennummer", "schadenummer", "schaden-nummer", "schaden-nr", "schaden-nr.",
  "nichtvorhanden", "nicht angegeben", "nichtangegeben", "nicht vorhanden",
  "n/a", "na", "none",
]);

const DEBLANK = (s: string) => s.replace(/\s+/g, "");
const ONLY_DIGITS = (s: string) => s.replace(/\D+/g, "");
const SIMPLE_NORM = (s: string) =>
    DEBLANK(String(s).toLowerCase())
    .replace(/[._\-:;,/\\|()[\]{}]+/g, "")
    .normalize("NFKC");

const slug = (s: string) =>
    String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "");

function isJunkValue(raw: any, finalKey?: string): boolean {
  if (raw == null) return true;
  if (typeof raw === "object") {
    if (typeof (raw as any).value !== "undefined")
      return isJunkValue((raw as any).value, finalKey);
    return false;
  }
  const s = String(raw).trim();
  if (!s) return true;
  const norm = SIMPLE_NORM(s);
  if (STOP_VALUES.has(norm)) return true;
  if (finalKey && finalKey.includes("schaden") && ONLY_DIGITS(s).length < 6) return true;
  return false;
}

type VoteBucket = { normKey: string; prettyValues: string[]; votes: number; quality: number; };

function qualityOf(value: string, finalKey?: string): number {
  const digits = ONLY_DIGITS(value);
  if (digits.length >= 10) return 1;
  if (digits.length >= 6) return 0.7;
  if (finalKey && finalKey.includes("name")) {
    const words = String(value).trim().split(/\s+/).length;
    return Math.min(1, 0.3 + words * 0.15);
  }
  return 0.4;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function hashId(s: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h);
}

function cryptoRandomId() {
  try {
    const buf = new Uint8Array(8);
    (globalThis.crypto ?? (globalThis as any).msCrypto).getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return String(Math.random()).slice(2);
  }
}

function toBoolLoose(v: any): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase();
  if (["true", "wahr", "ja", "yes", "1"].includes(s)) return true;
  if (["false", "falsch", "nein", "no", "0"].includes(s)) return false;
  return undefined;
}

/* ======= Mehrheits-Konsolidierung ======= */

function consolidateExtractionFromAttempts(attempts: Attempt[], key: string) {
  const buckets = new Map<string, VoteBucket>();
  const norm = (v: string) => {
    const d = ONLY_DIGITS(v);
    return d.length >= 6 ? d : SIMPLE_NORM(v);
  };

  for (const a of attempts) {
    const raw = a?.candidate_value && typeof a.candidate_value === "object" && "value" in a.candidate_value
        ? (a.candidate_value as any).value
        : a?.candidate_value;
    if (isJunkValue(raw, key)) continue;
    const s = String(raw);
    const nk = norm(s);
    const q = qualityOf(s, key);
    const b = buckets.get(nk) ?? { normKey: nk, prettyValues: [], votes: 0, quality: 0 };
    b.prettyValues.push(s);
    b.votes += 1;
    b.quality = Math.max(b.quality, q);
    buckets.set(nk, b);
  }

  const valid = Array.from(buckets.values());
  if (!valid.length) return { final_value: "—", final_confidence: 0, winnerNorm: null as string | null };

  valid.sort((a, b) => b.votes - a.votes || b.quality - a.quality);
  const top = valid[0];
  const second = valid[1];

  const totalVotes = valid.reduce((acc, b) => acc + b.votes, 0);
  const base = (top.votes + 0.5) / (totalVotes + 1);
  const margin = second ? Math.max(0, (top.votes - second.votes) / Math.max(1, totalVotes)) : 1;
  const conf = clamp01(base * 0.8 + margin * 0.2) * 0.8 + clamp01(top.quality) * 0.2;

  const pretty = (() => {
    const digits = top.normKey.replace(/\D+/g, "");
    if (digits.length >= 6) return digits; // kompakter bei IDs
    const counts = new Map<string, number>();
    for (const s of top.prettyValues) counts.set(s, (counts.get(s) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  })();

  return { final_value: pretty, final_confidence: conf, winnerNorm: top.normKey };
}

/* ============================== Converter ============================== */

function toRunDetail(payload: any): RunDetail {
  const runCore: RunCore = {
    id: String(payload?.run_id ?? payload?.id ?? cryptoRandomId()),
    pipeline_id: payload?.pipeline_id ?? payload?.run?.pipeline_id ?? null,
    pdf_id: payload?.pdf_id ?? payload?.run?.pdf_id ?? null,
    status: payload?.status ?? payload?.run?.status ?? "finalized",
    started_at: payload?.started_at ?? payload?.run?.started_at ?? null,
    finished_at: payload?.finished_at ?? payload?.run?.finished_at ?? null,
    overall_score:
        typeof payload?.overall_score === "number"
            ? payload.overall_score
            : typeof payload?.run?.overall_score === "number"
                ? payload.run.overall_score
                : 0,
    error: payload?.error ?? payload?.run?.error ?? null,
    final_extraction: {},
    final_decisions: {},
    final_scores: payload?.final_scores ?? payload?.run?.final_scores ?? {},
  };

  const steps: RunStep[] = [];
  const logArr: any[] = Array.isArray(payload?.log) ? payload.log : [];
  let orderCounter = 0;

  if (logArr.length) {
    for (const entry of logArr) {
      const ptype: StepType =
          entry?.prompt_type === "ExtractionPrompt" ? "Extraction" :
              entry?.prompt_type === "ScoringPrompt"   ? "Score" :
                  entry?.prompt_type === "DecisionPrompt"  ? "Decision" : "Extraction";

      const keySlug = slug(entry?.decision_key ?? entry?.result?.prompt_text ?? "step");

      if (ptype === "Extraction") {
        const res: any[] = Array.isArray(entry?.result?.results) ? entry.result.results : [];
        const bat: any[] = Array.isArray(entry?.result?.batches) ? entry.result.batches : [];

        const attempts: Attempt[] = res.map((r: any, i: number) => {
          const pnos: number[] = Array.isArray(bat[i]?.pages) ? bat[i].pages : [];
          const page = Number.isFinite(pnos?.[0]) ? (pnos[0] as number) + 1
              : (typeof r?.source?.page === "number" && r.source.page > 0 ? r.source.page : undefined);
          const quote = r?.source?.quote ?? entry?.result?.prompt_text ?? "(ohne Kontext)";
          return {
            id: `${keySlug}:${i+1}`,
            attempt_no: i + 1,
            candidate_key: quote,
            candidate_value: page != null ? { value: r?.value ?? null, page, source: { page, quote } }
                : { value: r?.value ?? null, source: { quote } },
            candidate_confidence: null,
            source: "llm",
            is_final: false
          };
        });

        const { final_value, final_confidence, winnerNorm } = consolidateExtractionFromAttempts(attempts, keySlug);
        const norm = (v: string) => {
          const d = ONLY_DIGITS(v);
          return d.length >= 6 ? d : SIMPLE_NORM(v);
        };
        attempts.forEach(a => {
          const val = a?.candidate_value?.value ?? a?.candidate_value;
          a.is_final = winnerNorm != null && !isJunkValue(val, keySlug) && norm(String(val)) === winnerNorm;
        });

        runCore.final_extraction![keySlug] = final_value;

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Extraction",
          status: "finalized",
          order_index: entry?.seq_no ?? (orderCounter - 1),
          definition: { json_key: keySlug },
          final_key: keySlug,
          final_value,
          final_confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts
        });
      }

      if (ptype === "Score") {
        const scores: any[] = Array.isArray(entry?.result?.scores) ? entry.result.scores : [];
        const attempts: Attempt[] = scores.map((r: any, i: number) => ({
          id: `${keySlug}:${i+1}`,
          attempt_no: i + 1,
          candidate_key: r?.source?.quote ?? entry?.result?.prompt_text ?? "(ohne Kontext)",
          candidate_value: !!r?.result, // boolean
          candidate_confidence: null,
          source: "llm",
          is_final: false
        }));
        // Mehrheit + Confidence
        let t = 0, f = 0;
        attempts.forEach(a => (a.candidate_value ? t++ : f++));
        const total = t + f;
        const consolidated = (typeof entry?.result?.consolidated?.result === "boolean")
            ? entry.result.consolidated.result
            : (t >= f);
        const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
        attempts.forEach(a => (a.is_final = a.candidate_value === consolidated));

        // final decision in run
        runCore.final_decisions![keySlug] = consolidated;

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Score",
          status: "finalized",
          order_index: entry?.seq_no ?? (orderCounter - 1),
          definition: { json_key: keySlug },
          final_key: keySlug,
          final_value: consolidated,
          final_confidence: confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts
        });
      }

      if (ptype === "Decision") {
        // votes[] bevorzugt; Fallback: results[] / boolean / route
        const votes: any[] = Array.isArray(entry?.result?.votes) ? entry.result.votes : [];
        const alts: any[] = Array.isArray(entry?.result?.results) ? entry.result.results : [];

        const rawItems = votes.length ? votes : alts;
        const attempts: Attempt[] = rawItems.map((r: any, i: number) => {
          const rawBool = typeof r?.boolean === "boolean" ? r.boolean : toBoolLoose(r?.value) ?? toBoolLoose(r?.route);
          const key = r?.source?.quote ?? r?.prompt_text ?? entry?.result?.prompt_text ?? "(ohne Kontext)";
          return {
            id: `${keySlug}:${i+1}`,
            attempt_no: i + 1,
            candidate_key: key,
            candidate_value: typeof rawBool === "boolean" ? rawBool : false, // unklar -> false
            candidate_confidence: null,
            source: r?.route ?? "llm",
            is_final: false
          };
        });

        let t = 0, f = 0;
        attempts.forEach(a => (a.candidate_value ? t++ : f++));
        const total = t + f;
        const consolidated = t >= f;
        const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
        attempts.forEach(a => (a.is_final = a.candidate_value === consolidated));

        runCore.final_decisions![keySlug] = consolidated;

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Decision",
          status: "finalized",
          order_index: entry?.seq_no ?? (orderCounter - 1),
          definition: { json_key: keySlug },
          final_key: keySlug,
          final_value: consolidated,
          final_confidence: confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts
        });
      }
    }
  } else {
    // Fallback: klassisch über Arrays
    const extractionArr: any[] = Array.isArray(payload?.extraction) ? payload.extraction : [];
    const groupsByKey = groupBy(extractionArr, (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "extraction"));
    for (const [keySlug, items] of groupsByKey) {
      orderCounter++;
      const { final_value, final_confidence, attempts } = consolidateExtractionGroup(items, keySlug);
      runCore.final_extraction![keySlug] = final_value;

      steps.push({
        id: hashId(keySlug, orderCounter),
        step_type: "Extraction",
        status: "finalized",
        order_index: orderCounter - 1,
        definition: { json_key: keySlug },
        final_key: keySlug,
        final_value,
        final_confidence,
        started_at: payload?.started_at ?? null,
        finished_at: payload?.finished_at ?? null,
        attempts
      });
    }

    // Decision-Fallback
    const decisionArr: any[] = Array.isArray(payload?.decision) ? payload.decision : [];
    if (decisionArr.length) {
      const dGroups = groupBy(decisionArr, (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "decision"));
      for (const [keySlug, items] of dGroups) {
        orderCounter++;
        const { value, confidence, attempts } = consolidateDecisionGroup(items, keySlug);
        runCore.final_decisions![keySlug] = value;

        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Decision",
          status: "finalized",
          order_index: orderCounter - 1,
          definition: { json_key: keySlug },
          final_key: keySlug,
          final_value: value,
          final_confidence: confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts
        });
      }
    }

    // Score-Fallback (aus payload.scoring → boolean-Mehrheit)
    const scoringArr: any[] = Array.isArray(payload?.scoring) ? payload.scoring : [];
    for (const s of scoringArr) {
      const keySlug = slug(s?.prompt_text ?? "scoring");
      const scores: any[] = Array.isArray(s?.scores) ? s.scores : [];
      const attempts: Attempt[] = scores.map((x: any, i: number) => ({
        id: `${keySlug}:${i+1}`,
        attempt_no: i + 1,
        candidate_key: x?.explanation ?? s?.prompt_text ?? "(ohne Kontext)",
        candidate_value: !!x?.result,
        candidate_confidence: null,
        source: "llm",
        is_final: false
      }));
      let t = 0, f = 0;
      attempts.forEach(a => (a.candidate_value ? t++ : f++));
      const total = t + f;
      const consolidated = (typeof s?.consolidated?.result === "boolean") ? s.consolidated.result : (t >= f);
      const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
      attempts.forEach(a => (a.is_final = a.candidate_value === consolidated));

      runCore.final_decisions![keySlug] = consolidated;

      orderCounter++;
      steps.push({
        id: hashId(keySlug, orderCounter),
        step_type: "Score",
        status: "finalized",
        order_index: orderCounter - 1,
        definition: { json_key: keySlug },
        final_key: keySlug,
        final_value: consolidated,
        final_confidence: confidence,
        started_at: payload?.started_at ?? null,
        finished_at: payload?.finished_at ?? null,
        attempts
      });
    }
  }

  return { run: runCore, steps, raw: payload };
}

/* ======= Fallback-Konsolidierer (ohne log) ======= */

function consolidateExtractionGroup(records: any[], finalKey: string) {
  const attempts: Attempt[] = [];
  let attemptNo = 0;

  for (const r of records) {
    attemptNo++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);

    const runnerPage =
        r?.source && typeof r.source.page === "number" && r.source.page > 0
            ? r.source.page
            : undefined;
    const rawPage =
        parsed?.source && typeof parsed.source.page === "number" && parsed.source.page > 0
            ? parsed.source.page
            : undefined;

    const page = runnerPage ?? rawPage;
    const quote =
        (r?.source && r.source.quote) ||
        (parsed?.source && parsed.source.quote) ||
        r?.prompt_text ||
        "(ohne Kontext)";

    const value = (typeof parsed?.value !== "undefined" ? parsed.value : r?.value) ?? null;
    const cv = page != null ? { value, page, source: { page, quote } } : { value, source: { quote } };

    attempts.push({
      id: r?.id ?? `${finalKey}:${attemptNo}`,
      attempt_no: attemptNo,
      candidate_key: quote,
      candidate_value: cv,
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false
    });
  }

  const { final_value, final_confidence, winnerNorm } = consolidateExtractionFromAttempts(attempts, finalKey);

  const norm = (v: string) => {
    const d = ONLY_DIGITS(v);
    return d.length >= 6 ? d : SIMPLE_NORM(v);
  };
  attempts.forEach(a => {
    const val = a?.candidate_value?.value ?? a?.candidate_value;
    a.is_final = winnerNorm != null && !isJunkValue(val, finalKey) && norm(String(val)) === winnerNorm;
  });

  return { final_value, final_confidence, attempts };
}

function consolidateDecisionGroup(items: any[], keySlug: string) {
  const attempts: Attempt[] = [];
  let t = 0, f = 0, idx = 0;

  for (const r of items) {
    idx++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);
    const v = typeof parsed?.value !== "undefined" ? parsed.value : r?.value;
    const b = toBoolLoose(v);
    if (b === true) t++;
    if (b === false) f++;

    attempts.push({
      id: r?.id ?? `${keySlug}:${idx}`,
      attempt_no: idx,
      candidate_key: parsed?.source?.quote ?? r?.prompt_text ?? "(ohne Kontext)",
      candidate_value: typeof b === "boolean" ? b : false,
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false
    });
  }

  const total = t + f;
  const result = t >= f;
  const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
  attempts.forEach(a => (a.is_final = a.candidate_value === result));
  return { value: result, confidence, attempts };
}

function getHistoryBase(): string {
  const w = (window as any);
  return w.__ENV__?.HISTORY_URL || (import.meta as any)?.env?.VITE_HISTORY_URL || "/hist";
}

function groupBy<T>(arr: T[], keyer: (v: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of arr) {
    const k = keyer(it);
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

function tryParseOpenAiRaw(raw: any): any | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.value !== "undefined" || typeof obj?.source !== "undefined") return obj;
  } catch { /* ignore */ }
  return undefined;
}
