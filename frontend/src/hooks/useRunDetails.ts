import * as React from "react";

/* ============================== Types ============================== */

export type StepType = "Extraction" | "Decision" | "Score";

// Tri-State Labels
export type TernaryLabel = "yes" | "no" | "unsure";

export interface Attempt {
  id?: number | string;
  attempt_no?: number;
  candidate_key?: string;

  // Für die UI: Seite sowohl flach (.page) als auch unter .source.page anbieten
  candidate_value?:
      | { value: any; page?: number; source?: { page?: number; quote?: string } }
      | any;

  // Für Tri-State: die KI liefert je Chunk/Page strukturierte Felder
  vote?: TernaryLabel;                 // "yes" | "no" | "unsure"
  strength?: number | null;            // 0..1 (Evidenzstärke)
  candidate_confidence?: number | null; // 0..1 (Antwortsicherheit)

  source?: string | null;
  is_final?: boolean;
}

function toPromptId(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export interface RunStep {
  id: number;
  step_type: StepType;
  status?:
      | "queued"
      | "running"
      | "finalized"
      | "completed"
      | "failed"
      | "timeout"
      | "canceled";
  order_index?: number;
  definition?: { json_key?: string } | null;

  // Zuordnung zum Prompt (für Weights etc.) – optional, da historische Runs es evtl. nicht enthalten
  prompt_id?: number | null;
  prompt_weight?: number | null;

  final_key?: string | null;
  final_value?: any;                 // Backwards-compat (bool bei Score/Decision)
  final_confidence?: number | null;  // 0..1

  // Neu: Tri-State konsolidiert (falls vorhanden)
  final_score_label?: TernaryLabel | null; // yes/no/unsure
  // Hinweis: der numerische Score (−1..+1) liegt in run.final_scores[final_key!]

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
  overall_score?: number | null; // 0..1 (Anzeige)

  error?: string | null;

  final_extraction?: Record<string, any>;
  final_decisions?: Record<string, boolean>;
  /**
   * Achtung:
   * - alte Runs: 1/0 (bool)
   * - neue Runs (Tri‑State): −1..+1
   */
  final_scores?: Record<string, number>;

  // optional: Label-Map falls Backend sie irgendwann mitsendet (keine Pflicht)
  final_score_labels?: Record<string, TernaryLabel>;

  // Optional: Prompt-Weights (Index per prompt_id)
  prompt_weights?: Record<number, number>;
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

        // 2) nur run_id → analyses?run_id → results/{pdf_id}
        if (!payload && runId) {
          const list = await tryFetchJson(`${HIST}/analyses?run_id=${encodeURIComponent(runId)}`);
          const first = Array.isArray(list) && list.length ? list[0] : undefined;
          const fromListPdf = Number(first?.pdf_id);
          if (Number.isFinite(fromListPdf)) {
            payload = await tryFetchJson(`${HIST}/results/${encodeURIComponent(fromListPdf)}`);
          }
        }

        // 3) letzter Versuch: /analyses/{id}/detail
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

        if (!payload)
          throw new Error(
              "Keine Run-Daten als JSON gefunden. (Die angefragten Endpunkte liefern HTML oder 4xx.)"
          );

        const normalized = toRunDetail(payload);
        if (!alive) return;

        await attachPromptWeights(normalized);
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

  // Summe der Scores (nur als Info-Zeile; Tri-State wird nicht normalisiert)
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
  "",
  "-",
  "–",
  "—",
  "schadennummer",
  "schadenummer",
  "schaden-nummer",
  "schaden-nr",
  "schaden-nr.",
  "nichtvorhanden",
  "nicht angegeben",
  "nichtangegeben",
  "nicht vorhanden",
  "n/a",
  "na",
  "none",
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

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
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
    return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  } catch {
    return String(Math.random()).slice(2);
  }
}

function tryParseOpenAiRaw(raw: any): any | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.value !== "undefined" || typeof obj?.source !== "undefined") return obj;
  } catch {
    /* ignore */
  }
  return undefined;
}

function toBoolLoose(v: any): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase().trim();
  if (["true", "wahr", "ja", "yes", "1"].includes(s)) return true;
  if (["false", "falsch", "nein", "no", "0"].includes(s)) return false;
  return undefined;
}

// leerer Kandidat?
function isEmptyCandidateValue(val: any): boolean {
  const raw = val && typeof val === "object" && "value" in val ? (val as any).value : val;
  if (raw == null) return true;
  if (typeof raw === "string" && raw.trim() === "") return true;
  return false;
}

/* ======= Qualität & Mehrheits-Konsolidierung ======= */

type VoteBucket = {
  normKey: string;
  prettyValues: string[];
  votes: number;
  quality: number;
};

function isJunkValue(raw: any, finalKey?: string): boolean {
  if (raw == null) return true;
  if (typeof raw === "object") {
    if (typeof (raw as any).value !== "undefined") return isJunkValue((raw as any).value, finalKey);
    return false;
  }
  const s = String(raw).trim();
  if (!s) return true;
  const norm = SIMPLE_NORM(s);
  if (STOP_VALUES.has(norm)) return true;
  if (finalKey && finalKey.includes("schaden") && ONLY_DIGITS(s).length < 6) return true;
  return false;
}

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
    const b =
        buckets.get(nk) ??
        {
          normKey: nk,
          prettyValues: [],
          votes: 0,
          quality: 0,
        };
    b.prettyValues.push(s);
    b.votes += 1;
    b.quality = Math.max(b.quality, q);
    buckets.set(nk, b);
  }

  const valid = Array.from(buckets.values());
  if (!valid.length)
    return { final_value: "—", final_confidence: 0, winnerNorm: null as string | null };

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
    final_score_labels: payload?.final_score_labels ?? payload?.run?.final_score_labels ?? undefined,
  };

  // Boolean -> number Normalisierung (alte Runs)
  if (runCore.final_scores) {
    for (const k of Object.keys(runCore.final_scores)) {
      const v = (runCore.final_scores as any)[k];
      if (typeof v === "boolean") {
        // Alt: bool → 1/0
        (runCore.final_scores as any)[k] = v ? 1 : 0;
      }
    }
  }

  const steps: RunStep[] = [];
  const logArr: any[] = Array.isArray(payload?.log) ? payload.log : [];
  let orderCounter = 0;

  if (logArr.length) {
    // Bevorzugt: Steps aus log (mit batches → echte Seiten)
    for (const entry of logArr) {
      const ptype: StepType =
          entry?.prompt_type === "ExtractionPrompt"
              ? "Extraction"
              : entry?.prompt_type === "ScoringPrompt"
                  ? "Score"
                  : entry?.prompt_type === "DecisionPrompt"
                      ? "Decision"
                      : "Extraction";

      const keySlug = slug(entry?.decision_key ?? entry?.result?.prompt_text ?? "step");

      if (ptype === "Extraction") {
        const promptId = toPromptId(entry?.prompt_id);
        const res: any[] = Array.isArray(entry?.result?.results) ? entry.result.results : [];
        const bat: any[] = Array.isArray(entry?.result?.batches) ? entry.result.batches : [];

        // Roh-Attempts bauen
        const attemptsRaw: Attempt[] = res.map((r: any, i: number) => {
          const pnos: number[] = Array.isArray(bat[i]?.pages) ? bat[i].pages : [];
          const page =
              Number.isFinite(pnos?.[0])
                  ? (pnos[0] as number) + 1
                  : typeof r?.source?.page === "number" && r.source.page > 0
                      ? r.source.page
                      : undefined;
          const quote = r?.source?.quote ?? entry?.result?.prompt_text ?? "(ohne Kontext)";
          return {
            id: `${keySlug}:${i + 1}`,
            attempt_no: i + 1,
            candidate_key: quote,
            candidate_value:
                page != null
                    ? { value: r?.value ?? null, page, source: { page, quote } }
                    : { value: r?.value ?? null, source: { quote } },
            candidate_confidence: null,
            source: "llm",
            is_final: false,
          };
        });

        // Kandidaten mit leerem Value ausblenden
        const attempts = attemptsRaw.filter((a) => !isEmptyCandidateValue(a.candidate_value));

        const { final_value, final_confidence, winnerNorm } = consolidateExtractionFromAttempts(
            attempts,
            keySlug
        );
        const norm = (v: string) => {
          const d = ONLY_DIGITS(v);
          return d.length >= 6 ? d : SIMPLE_NORM(v);
        };
        attempts.forEach((a) => {
          const val = a?.candidate_value?.value ?? a?.candidate_value;
          a.is_final = winnerNorm != null && !isJunkValue(val, keySlug) && norm(String(val)) === winnerNorm;
        });

        // Finale Extraktion inkl. confidence speichern (Key = json_key/decision_key)
        runCore.final_extraction![keySlug] = { value: final_value, confidence: final_confidence };

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Extraction",
          status: "finalized",
          order_index: entry?.seq_no ?? orderCounter - 1,
          definition: { json_key: keySlug },
          prompt_id: promptId,
          final_key: keySlug,
          final_value,
          final_confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts,
        });
      }

      if (ptype === "Score") {
        const promptId = toPromptId(entry?.prompt_id);
        const scores: any[] = Array.isArray(entry?.result?.scores) ? entry.result.scores : [];
        const bat: any[] = Array.isArray(entry?.result?.batches) ? entry.result.batches : [];

        const attemptsRaw: Attempt[] = scores.map((r: any, i: number) => {
          const pnos: number[] = Array.isArray(bat[i]?.pages) ? bat[i].pages : [];
          const page = Number.isFinite(pnos?.[0]) ? (pnos[0] as number) + 1 : undefined;
          const quote = r?.explanation ?? entry?.result?.prompt_text ?? "(ohne Kontext)";

          // Tri‑State Felder
          const rawVote: string | undefined = (r?.vote ?? r?.value?.vote)?.toString()?.toLowerCase();
          const vote: TernaryLabel | undefined =
              rawVote === "yes" ? "yes" : rawVote === "no" ? "no" : rawVote === "unsure" ? "unsure" : undefined;

          const strength = typeof r?.strength === "number" ? r.strength : null;
          const conf = typeof r?.confidence === "number" ? r.confidence : null;

          // Backward‑Compat: bool (falls es keinen vote gibt)
          const boolVal =
              typeof r?.result === "boolean"
                  ? r.result
                  : typeof r?.value?.result === "boolean"
                      ? r.value.result
                      : undefined;

          const valueForCard = vote ?? (typeof boolVal === "boolean" ? (boolVal ? "yes" : "no") : undefined);

          return {
            id: `${keySlug}:${i + 1}`,
            attempt_no: i + 1,
            candidate_key: quote,
            candidate_value:
                page != null
                    ? { value: valueForCard, page, source: { page, quote } }
                    : { value: valueForCard, source: { quote } },
            vote,
            strength,
            candidate_confidence: conf,
            source: "llm",
            is_final: false,
          };
        });

        // Keine Filterung mehr auf reine Booleans → Tri‑State bleibt sichtbar
        const attempts = attemptsRaw;

        // Konsolidiert: bevorzugt Tri‑State vom Modell; sonst Boolean-Mehrheit wie bisher
        const cons = entry?.result?.consolidated ?? {};
        const consScore =
            typeof cons?.score === "number" ? clamp(cons.score, -1, 1) : undefined;
        const consLabelRaw = typeof cons?.label === "string" ? cons.label.toLowerCase() : undefined;
        const consLabel: TernaryLabel | undefined =
            consLabelRaw === "yes" ? "yes" : consLabelRaw === "no" ? "no" : consLabelRaw === "unsure" ? "unsure" : undefined;
        const consConf = typeof cons?.confidence === "number" ? cons.confidence : undefined;

        // Fallbacks aus Attempts (Mehrheit/Heuristik), falls keine Tri‑State-Konsolidierung vorhanden
        let t = 0, f = 0;
        attempts.forEach((a) => {
          const vv = (a.vote ?? "").toString().toLowerCase();
          if (vv === "yes") t++;
          else if (vv === "no") f++;
          else {
            // kein vote → evtl. bool?
            const raw =
                typeof a.candidate_value === "object"
                    ? (a.candidate_value as any)?.value
                    : a.candidate_value;
            const b = toBoolLoose(raw);
            if (b === true) t++;
            if (b === false) f++;
          }
        });
        const total = t + f;
        const majBool = t >= f;
        const majConfidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;

        // Finales Label/Score/Confidence
        const finalScore = typeof consScore === "number" ? consScore : majBool ? 1 : -1;
        const finalLabel: TernaryLabel =
            consLabel ?? (finalScore >= 0.6 ? "yes" : finalScore <= -0.6 ? "no" : "unsure");
        const finalConfidence = typeof consConf === "number" ? consConf : majConfidence;

        // Attempts markieren (Final)
        attempts.forEach((a) => {
          if (a.vote) {
            a.is_final = a.vote === finalLabel;
          } else {
            const v =
                typeof a.candidate_value === "object"
                    ? (a.candidate_value as any)?.value
                    : a.candidate_value;
            const b = toBoolLoose(v);
            a.is_final = typeof b === "boolean" ? (finalLabel === "yes" ? b === true : finalLabel === "no" ? b === false : false) : false;
          }
        });

        // Backend-Map (−1..+1) eintragen; Falls alter Bool → +1/−1, alte Booleans (true/false) bleiben 1/0 in historischen Runs
        runCore.final_scores![keySlug] = finalScore;
        // optional Label-Map (falls im Frontend benutzt)
        (runCore.final_score_labels ??= {})[keySlug] = finalLabel;

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Score",
          status: "finalized",
          order_index: entry?.seq_no ?? orderCounter - 1,
          definition: { json_key: keySlug },
          prompt_id: promptId,
          final_key: keySlug,
          // Backwards-Compat: final_value bleibt boolean (für ältere Karten)
          final_value: finalLabel === "yes" ? true : finalLabel === "no" ? false : undefined,
          final_confidence: finalConfidence,
          final_score_label: finalLabel,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts,
        });
      }

      if (ptype === "Decision") {
        const promptId = toPromptId(entry?.prompt_id);
        const votes: any[] = Array.isArray(entry?.result?.votes) ? entry.result.votes : [];
        const alts: any[] = Array.isArray(entry?.result?.results) ? entry.result.results : [];
        const bat: any[] = Array.isArray(entry?.result?.batches) ? entry.result.batches : [];
        const rawItems = votes.length ? votes : alts;

        const attemptsRaw: Attempt[] = rawItems.map((r: any, i: number) => {
          const pnos: number[] = Array.isArray(bat[i]?.pages) ? bat[i].pages : [];
          const page =
              Number.isFinite(pnos?.[0])
                  ? (pnos[0] as number) + 1
                  : typeof r?.source?.page === "number" && r.source.page > 0
                      ? r.source.page
                      : undefined;
          const rawBool =
              typeof r?.boolean === "boolean" ? r.boolean : toBoolLoose(r?.value) ?? toBoolLoose(r?.route);
          const key =
              r?.source?.quote ?? r?.prompt_text ?? entry?.result?.prompt_text ?? "(ohne Kontext)";
          return {
            id: `${keySlug}:${i + 1}`,
            attempt_no: i + 1,
            candidate_key: key,
            candidate_value:
                page != null ? { value: rawBool, page, source: { page, quote: key } } : rawBool,
            candidate_confidence: null,
            source: r?.route ?? "llm",
            is_final: false,
          };
        });

        // Nur boolesche Kandidaten behalten
        const attempts = attemptsRaw.filter((a) => {
          const v = typeof a.candidate_value === "object" ? (a.candidate_value as any)?.value : a.candidate_value;
          return typeof v === "boolean";
        });

        let t = 0,
            f = 0;
        attempts.forEach((a) => {
          const v = typeof a.candidate_value === "object" ? !!(a.candidate_value as any).value : !!a.candidate_value;
          v ? t++ : f++;
        });
        const total = t + f;
        const consolidated = t >= f;
        const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
        attempts.forEach((a) => {
          const v = typeof a.candidate_value === "object" ? !!(a.candidate_value as any).value : !!a.candidate_value;
          a.is_final = v === consolidated;
        });

        runCore.final_decisions![keySlug] = consolidated;

        orderCounter++;
        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Decision",
          status: "finalized",
          order_index: entry?.seq_no ?? orderCounter - 1,
          definition: { json_key: keySlug },
          prompt_id: promptId,
          final_key: keySlug,
          final_value: consolidated,
          final_confidence: confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts,
        });
      }
    }
  } else {
    // Fallback: kein log → klassisch über Arrays

    // Extraction
    const extractionArr: any[] = Array.isArray(payload?.extraction) ? payload.extraction : [];
    const groupsByKey = groupBy(
        extractionArr,
        (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "extraction")
    );
    for (const [keySlug, items] of groupsByKey) {
      orderCounter++;
      const promptId = (() => {
        for (const it of items) {
          const pid = toPromptId(it?.prompt_id);
          if (pid != null) return pid;
        }
        return null;
      })();
      const { final_value, final_confidence, attempts } = consolidateExtractionGroup(items, keySlug);

      // Finale Extraktion inkl. confidence
      runCore.final_extraction![keySlug] = { value: final_value, confidence: final_confidence };

      steps.push({
        id: hashId(keySlug, orderCounter),
        step_type: "Extraction",
        status: "finalized",
        order_index: orderCounter - 1,
        definition: { json_key: keySlug },
        prompt_id: promptId,
        final_key: keySlug,
        final_value,
        final_confidence,
        started_at: payload?.started_at ?? null,
        finished_at: payload?.finished_at ?? null,
        attempts,
      });
    }

    // Decision
    const decisionArr: any[] = Array.isArray(payload?.decision) ? payload.decision : [];
    if (decisionArr.length) {
      const dGroups = groupBy(
          decisionArr,
          (r) => slug(r?.json_key ?? r?.final_key ?? r?.prompt_text ?? "decision")
      );
      for (const [keySlug, items] of dGroups) {
        orderCounter++;
        const promptId = (() => {
          for (const it of items) {
            const pid = toPromptId(it?.prompt_id);
            if (pid != null) return pid;
          }
          return null;
        })();
        const { value, confidence, attempts } = consolidateDecisionGroup(items, keySlug);
        runCore.final_decisions![keySlug] = value;

        steps.push({
          id: hashId(keySlug, orderCounter),
          step_type: "Decision",
          status: "finalized",
          order_index: orderCounter - 1,
          definition: { json_key: keySlug },
          prompt_id: promptId,
          final_key: keySlug,
          final_value: value,
          final_confidence: confidence,
          started_at: payload?.started_at ?? null,
          finished_at: payload?.finished_at ?? null,
          attempts,
        });
      }
    }

    // Score (Fallback: Bool-Mehrheit)
    const scoringArr: any[] = Array.isArray(payload?.scoring) ? payload.scoring : [];
    for (const s of scoringArr) {
      const keySlug = slug(s?.prompt_text ?? "scoring");
      const promptId = toPromptId(s?.prompt_id);
      const scores: any[] = Array.isArray(s?.scores) ? s.scores : [];
      const attemptsRaw: Attempt[] = scores.map((x: any, i: number) => ({
        id: `${keySlug}:${i + 1}`,
        attempt_no: i + 1,
        candidate_key: x?.explanation ?? s?.prompt_text ?? "(ohne Kontext)",
        candidate_value: !!x?.result,
        candidate_confidence: null,
        source: "llm",
        is_final: false,
      }));
      const attempts = attemptsRaw.filter((a) => typeof a.candidate_value === "boolean");

      let t = 0,
          f = 0;
      attempts.forEach((a) => (a.candidate_value ? t++ : f++));
      const total = t + f;
      const consolidated = typeof s?.consolidated?.result === "boolean" ? s.consolidated.result : t >= f;
      const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
      attempts.forEach((a) => (a.is_final = a.candidate_value === consolidated));

      // Fallback: 1/0
      runCore.final_scores![keySlug] = consolidated ? 1 : 0;

      orderCounter++;
      steps.push({
        id: hashId(keySlug, orderCounter),
        step_type: "Score",
        status: "finalized",
        order_index: orderCounter - 1,
        definition: { json_key: keySlug },
        prompt_id: promptId,
        final_key: keySlug,
        final_value: consolidated,
        final_confidence: confidence,
        started_at: payload?.started_at ?? null,
        finished_at: payload?.finished_at ?? null,
        attempts,
      });
    }
  }

  return { run: runCore, steps, raw: payload };
}

/* ======= Fallback-Konsolidierer (ohne log) ======= */

function consolidateExtractionGroup(records: any[], finalKey: string) {
  const attemptsRaw: Attempt[] = [];
  let attemptNo = 0;

  for (const r of records) {
    attemptNo++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);

    const runnerPage = r?.source && typeof r.source.page === "number" && r.source.page > 0 ? r.source.page : undefined;
    const rawPage = parsed?.source && typeof parsed.source.page === "number" && parsed.source.page > 0 ? parsed.source.page : undefined;

    const page = runnerPage ?? rawPage;
    const quote =
        (r?.source && r.source.quote) || (parsed?.source && parsed.source.quote) || r?.prompt_text || "(ohne Kontext)";

    const value = (typeof parsed?.value !== "undefined" ? parsed.value : r?.value) ?? null;
    const cv = page != null ? { value, page, source: { page, quote } } : { value, source: { quote } };

    attemptsRaw.push({
      id: r?.id ?? `${finalKey}:${attemptNo}`,
      attempt_no: attemptNo,
      candidate_key: quote,
      candidate_value: cv,
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false,
    });
  }

  // Kandidaten mit leerem Value ausblenden
  const attempts = attemptsRaw.filter((a) => !isEmptyCandidateValue(a.candidate_value));

  const { final_value, final_confidence, winnerNorm } = consolidateExtractionFromAttempts(attempts, finalKey);

  const norm = (v: string) => {
    const d = ONLY_DIGITS(v);
    return d.length >= 6 ? d : SIMPLE_NORM(v);
  };
  attempts.forEach((a) => {
    const val = a?.candidate_value?.value ?? a?.candidate_value;
    a.is_final = winnerNorm != null && !isJunkValue(val, finalKey) && norm(String(val)) === winnerNorm;
  });

  return { final_value, final_confidence, attempts };
}

function consolidateDecisionGroup(items: any[], keySlug: string) {
  const attemptsRaw: Attempt[] = [];
  let t = 0,
      f = 0,
      idx = 0;

  for (const r of items) {
    idx++;
    const parsed = tryParseOpenAiRaw(r?.openai_raw);
    const v = typeof parsed?.value !== "undefined" ? parsed.value : r?.value;
    const b = toBoolLoose(v);

    const attempt: Attempt = {
      id: r?.id ?? `${keySlug}:${idx}`,
      attempt_no: idx,
      candidate_key: parsed?.source?.quote ?? r?.prompt_text ?? "(ohne Kontext)",
      candidate_value: typeof b === "boolean" ? b : undefined,
      candidate_confidence: null,
      source: r?.route ?? "llm",
      is_final: false,
    };
    attemptsRaw.push(attempt);
  }

  const attempts = attemptsRaw.filter((a) => typeof a.candidate_value === "boolean");

  attempts.forEach((a) => {
    if (a.candidate_value === true) t++;
    else f++;
  });

  const total = t + f;
  const result = t >= f;
  const confidence = total > 0 ? (Math.max(t, f) + 0.5) / (total + 1) : 0;
  attempts.forEach((a) => (a.is_final = a.candidate_value === result));
  return { value: result, confidence, attempts };
}

/* ============================== Small utils ============================== */

function getHistoryBase(): string {
  const w = (window as any);
  return w.__ENV__?.HISTORY_URL || (import.meta as any)?.env?.VITE_HISTORY_URL || "/hist";
}

function getPromptApiBase(): string {
  const w = (window as any);
  return (
      w.__ENV__?.PROMPT_API_URL ||
      (import.meta as any)?.env?.VITE_PROMPT_API_URL ||
      "http://localhost:8082"
  );
}

async function attachPromptWeights(detail: RunDetail): Promise<void> {
  const scoringIds = new Set<number>();
  const decisionIds = new Set<number>();

  for (const step of detail.steps ?? []) {
    const pid = toPromptId(step?.prompt_id);
    if (pid == null) continue;
    if (step.step_type === "Score") scoringIds.add(pid);
    else if (step.step_type === "Decision") decisionIds.add(pid);
  }

  if (scoringIds.size === 0 && decisionIds.size === 0) {
    return;
  }

  const needed = new Set<number>([...scoringIds, ...decisionIds]);
  const base = getPromptApiBase();

  const fetchType = async (type: "ScoringPrompt" | "DecisionPrompt") => {
    try {
      const res = await fetch(`${base}/prompts?type=${type}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [] as any[];
      const json = await res.json();
      return Array.isArray(json) ? json : [];
    } catch (err) {
      console.warn("Prompt-Weights laden fehlgeschlagen", type, err);
      return [] as any[];
    }
  };

  const [scoringPrompts, decisionPrompts] = await Promise.all([
    scoringIds.size ? fetchType("ScoringPrompt") : Promise.resolve([] as any[]),
    decisionIds.size ? fetchType("DecisionPrompt") : Promise.resolve([] as any[]),
  ]);

  const weights: Record<number, number> = {};

  const absorb = (list: any[]) => {
    for (const item of list) {
      const pid = toPromptId(item?.id);
      const weight = typeof item?.weight === "number" ? item.weight : Number(item?.weight);
      if (pid == null || !Number.isFinite(weight) || !needed.has(pid)) continue;
      weights[pid] = weight;
    }
  };

  absorb(scoringPrompts);
  absorb(decisionPrompts);

  if (Object.keys(weights).length === 0) {
    return;
  }

  detail.run.prompt_weights = weights;
  detail.steps = detail.steps.map((step) => {
    const pid = toPromptId(step?.prompt_id);
    if (pid != null && typeof weights[pid] === "number") {
      return { ...step, prompt_weight: weights[pid] };
    }
    return step;
  });
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
