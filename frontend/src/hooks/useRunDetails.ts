import * as React from "react";

/* ============================== Types ============================== */

export type StepType = "Extraction" | "Decision" | "Score";

export interface Attempt {
  id?: number | string;
  attempt_no?: number;
  candidate_key?: string;
  candidate_value?: any; // kann string oder {value, source:{page}} sein
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

        // Robust nur JSON laden. HTML (<!DOCTYPE ...) -> undefined.
        const tryFetchJson = async (url: string): Promise<any | undefined> => {
          try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) return undefined;
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) return await res.json();

            const text = await res.text();
            if (!text || text.trim().startsWith("<")) return undefined;
            try {
              return JSON.parse(text);
            } catch {
              return undefined;
            }
          } catch {
            return undefined;
          }
        };

        // pdfId herleiten: opts → localStorage
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
          } catch {
            /* ignore */
          }
        }

        // 1) bevorzugt: /hist/results/{pdf_id}
        let payload: any | undefined = undefined;
        if (candidatePdfId != null) {
          payload = await tryFetchJson(`${HIST}/results/${encodeURIComponent(candidatePdfId)}`);
        }

        // 2) wenn nur run_id – über /analyses?run_id=… pdf_id ermitteln → results/{pdf_id}
        if (!payload && runId) {
          const list = await tryFetchJson(`${HIST}/analyses?run_id=${encodeURIComponent(runId)}`);
          const first = Array.isArray(list) && list.length ? list[0] : undefined;
          const fromListPdf = Number(first?.pdf_id);
          if (Number.isFinite(fromListPdf)) {
            payload = await tryFetchJson(`${HIST}/results/${encodeURIComponent(fromListPdf)}`);
          }
        }

        // 3) als letzter Versuch: /analyses/{id}/detail (falls dein Backend das liefert)
        if (!payload && runId) {
          payload = await tryFetchJson(`${HIST}/analyses/${encodeURIComponent(runId)}/detail`);
        }

        // 4) Fallback: LocalStorage kompletter Run
        if (!payload && opts?.storageKey) {
          try {
            const raw = localStorage.getItem(opts.storageKey);
            if (raw) {
              const parsed = JSON.parse(raw);
              payload = parsed?.run ?? parsed;
            }
          } catch {
            /* ignore */
          }
        }

        if (!payload) {
          throw new Error(
              "Keine Run-Daten als JSON gefunden. (Die angefragten Endpunkte liefern HTML oder 4xx.)"
          );
        }

        const normalized = toRunDetail(payload);
        if (!alive) return;
        setData(normalized);

        // nützlich: persistieren (pdfId) für spätere Reiter
        try {
          if (opts?.storageKey) {
            localStorage.setItem(
                opts.storageKey,
                JSON.stringify({ pdfId: normalized.run.pdf_id, run: normalized.run })
            );
          }
        } catch {
          /* ignore */
        }

        setLoading(false);
      } catch (e: any) {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
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

/* ============================== Transform / Consolidation ============================== */

// sehr schlichte Stoppliste für offensichtliche Nicht-Werte
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

// heuristik: "ist dieses string-fragment als leer/junk zu werten?"
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

type VoteBucket = {
  normKey: string; // Kanonschreibweise (z. B. digits-only)
  prettyValues: string[];
  votes: number;
  quality: number; // 0..1
};

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

function consolidateExtractionGroup(records: any[], finalKey: string) {
  const buckets = new Map<string, VoteBucket>();
  const attempts: Attempt[] = [];

  const normStrategy = (v: string) => {
    const d = ONLY_DIGITS(v);
    if (d.length >= 6) return d;
    return SIMPLE_NORM(v);
  };

  let attemptNo = 0;
  for (const r of records) {
    attemptNo++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);
    const page = parsed?.source?.page ?? r?.source?.page ?? undefined;

    const value = (typeof parsed?.value !== "undefined" ? parsed.value : r?.value) ?? null;
    const displayVal = value == null ? "" : String(value);

    if (isJunkValue(displayVal, finalKey)) {
      attempts.push({
        id: r?.id ?? `${finalKey}:${attemptNo}`,
        attempt_no: attemptNo,
        candidate_key:
            parsed?.source?.quote ?? r?.source?.quote ?? r?.prompt_text ?? "(ohne Kontext)",
        candidate_value: displayVal,
        candidate_confidence: null,
        source: r?.route ?? "llm",
        is_final: false,
      });
      continue;
    }

    const normKey = normStrategy(displayVal);
    const quality = qualityOf(displayVal, finalKey);

    const b =
        buckets.get(normKey) ?? { normKey, prettyValues: [], votes: 0, quality: 0 };
    b.prettyValues.push(displayVal);
    b.votes += 1;
    b.quality = Math.max(b.quality, quality);
    buckets.set(normKey, b);

    attempts.push({
      id: r?.id ?? `${finalKey}:${attemptNo}`,
      attempt_no: attemptNo,
      candidate_key:
          parsed?.source?.quote ?? r?.source?.quote ?? r?.prompt_text ?? "(ohne Kontext)",
      candidate_value: page ? { value: displayVal, source: { page } } : displayVal,
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false,
    });
  }

  const valid = Array.from(buckets.values());
  if (!valid.length) {
    return { final_value: "—", final_confidence: 0, attempts };
  }

  valid.sort((a, b) => b.votes - a.votes || b.quality - a.quality);
  const top = valid[0];
  const second = valid[1];

  const totalVotes = valid.reduce((acc, b) => acc + b.votes, 0);
  const base = (top.votes + 0.5) / (totalVotes + 1);
  const margin = second
      ? Math.max(0, (top.votes - second.votes) / Math.max(1, totalVotes))
      : 1;
  const conf = clamp01(base * 0.8 + margin * 0.2) * 0.8 + clamp01(top.quality) * 0.2;

  const pretty = (() => {
    const digits = top.normKey.replace(/\D+/g, "");
    if (digits.length >= 6) return digits;
    const counts = new Map<string, number>();
    for (const s of top.prettyValues) counts.set(s, (counts.get(s) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  })();

  for (const a of attempts) {
    const rawVal =
        typeof a.candidate_value === "object" &&
        a.candidate_value &&
        "value" in a.candidate_value
            ? (a.candidate_value as any).value
            : a.candidate_value;
    const isWin =
        !isJunkValue(rawVal, finalKey) &&
        normStrategy(String(rawVal)) === top.normKey;
    a.is_final = Boolean(isWin);
  }

  return { final_value: pretty, final_confidence: conf, attempts };
}

function consolidateDecisionGroup(items: any[], keySlug: string) {
  const toBool = (v: any): boolean | undefined => {
    if (typeof v === "boolean") return v;
    const s = String(v ?? "").toLowerCase().trim();
    if (["true", "wahr", "ja", "yes", "1"].includes(s)) return true;
    if (["false", "falsch", "nein", "no", "0"].includes(s)) return false;
    return undefined;
  };

  const attempts: Attempt[] = [];
  let t = 0,
      f = 0,
      idx = 0;

  for (const r of items) {
    idx++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);
    const v = typeof parsed?.value !== "undefined" ? parsed.value : r?.value;
    const b = toBool(v);
    if (b === true) t++;
    if (b === false) f++;

    attempts.push({
      id: r?.id ?? `${keySlug}:${idx}`,
      attempt_no: idx,
      candidate_key: parsed?.source?.quote ?? r?.prompt_text ?? "(ohne Kontext)",
      candidate_value: typeof b === "boolean" ? b : String(v ?? "—"),
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false,
    });
  }

  const total = t + f;
  const result = t >= f; // Gleichstand -> true
  const conf = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;

  for (const a of attempts) {
    const v =
        typeof a.candidate_value === "boolean"
            ? a.candidate_value
            : (() => {
              const s = String(a.candidate_value ?? "").toLowerCase().trim();
              if (["true", "wahr", "ja", "yes", "1"].includes(s)) return true;
              if (["false", "falsch", "nein", "no", "0"].includes(s)) return false;
              return undefined;
            })();
    a.is_final = typeof v === "boolean" && v === result;
  }

  return { value: result, confidence: conf, attempts };
}

/* ============================== Main converter ============================== */

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

  // ---------- Extraction ----------
  const extractionArr: any[] = Array.isArray(payload?.extraction)
      ? payload.extraction
      : [];
  const groupsByKey = groupBy(
      extractionArr,
      (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "extraction")
  );
  let orderCounter = 0;
  for (const [keySlug, items] of groupsByKey) {
    orderCounter++;
    const { final_value, final_confidence, attempts } = consolidateExtractionGroup(
        items,
        keySlug
    );
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
      attempts,
    });
  }

  // ---------- Decision ----------
  const decisionArr: any[] = Array.isArray(payload?.decision) ? payload.decision : [];
  if (decisionArr.length) {
    const dGroups = groupBy(
        decisionArr,
        (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "decision")
    );
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
        attempts,
      });
    }
  }

  // ---------- ScoringPrompt → boolean-Mehrheit als Entscheidung, Scores separat ----------
  const scoringArr: any[] = Array.isArray(payload?.scoring) ? payload.scoring : [];
  for (const s of scoringArr) {
    const keySlug = slug(s?.prompt_text ?? "scoring");
    const scores: any[] = Array.isArray(s?.scores) ? s.scores : [];
    const itemsLikeExtraction = scores.map((x: any) => ({
      prompt_text: s?.prompt_text,
      openai_raw: JSON.stringify({
        value: !!x?.result,
        source: { quote: x?.explanation ?? "" },
      }),
    }));
    orderCounter++;
    const { value, confidence, attempts } = consolidateDecisionGroup(
        itemsLikeExtraction,
        keySlug
    );
    runCore.final_decisions![keySlug] = Boolean(
        typeof s?.consolidated?.result === "boolean" ? s.consolidated.result : value
    );

    steps.push({
      id: hashId(keySlug, orderCounter),
      step_type: "Score",
      status: "finalized",
      order_index: orderCounter - 1,
      definition: { json_key: keySlug },
      final_key: keySlug,
      final_value: Boolean(runCore.final_decisions![keySlug]),
      final_confidence: confidence,
      attempts,
    });
  }

  return { run: runCore, steps, raw: payload };
}

/* ============================== Small utils ============================== */

function getHistoryBase(): string {
  const w = (window as any);
  return (
      w.__ENV__?.HISTORY_URL ||
      (import.meta as any)?.env?.VITE_HISTORY_URL ||
      "/hist"
  );
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
  } catch {
    // ignore
  }
  return undefined;
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
