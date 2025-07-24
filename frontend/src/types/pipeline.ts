/* eslint-disable @typescript-eslint/consistent-type-definitions */

/* ------------------------------------------------------------------------
 * Gemeinsame Typen für Editor, Backend‑API und Ergebnis‑Ansicht
 * ------------------------------------------------------------------------
 * – Generiert oder manuell gepflegt auf Basis von `pipeline_graph.rs`
 * – Alle React‑Dateien sollten ab sofort NUR noch hier importieren:
 *       import type { PipelineGraph, PipelineRunResult, ... } from '@/types/pipeline';
 * ---------------------------------------------------------------------- */

export type UUID = string;

/* ---------- Model: Pipeline‑Definition (DAG) --------------------------- */

export type PromptType =
    | 'TriggerPrompt'
    | 'AnalysisPrompt'
    | 'FollowUpPrompt'
    | 'DecisionPrompt'
    | 'FinalPrompt'
    | 'MetaPrompt';

export type EdgeType =
    | 'always'
    | 'onTrue'
    | 'onFalse'
    | 'onScore'
    | 'onError';

export interface PromptNode {
  id: UUID;
  text: string;
  /** Feld heißt in Rust `type_`, wird hier wieder als `type` exportiert */
  type: PromptType;
  weight?: number;                // nur Analysis/Decision
  confidenceThreshold?: number;   // Decision
  metadata?: unknown;
}

export interface Edge {
  id: UUID;
  source: UUID;
  target: UUID;
  condition?: string;             // z. B. "score > 0.8"
  type: EdgeType;                 // default "always"
}

export interface Stage {
  id: UUID;
  name: string;
  promptIds: UUID[];
  scoreFormula?: string;          // mathjs‑Syntax
}

export interface LabelRule {
  /** z. B. "score < 0.3"  */
  if: string;
  label: string;
}

export interface FinalScoring {
  scoreFormula: string;
  labelRules: LabelRule[];
}

export interface PipelineGraph {
  nodes: PromptNode[];
  edges: Edge[];
  stages: Stage[];
  finalScoring: FinalScoring;
}

/* ---------- Model: Pipeline‑Laufergebnis -------------------------------- */

export interface PromptResult {
  promptId: UUID;
  promptType: PromptType;
  status: 'Pending' | 'Running' | 'Done' | 'Skipped';
  result?: boolean;
  score?: number;
  answer?: string;
  source?: string;
  startedAt: string;
  finishedAt: string;
}

/** passt zu Stage‑Score‑Panel in den bestehenden Komponenten */
export interface StageScore {
  id: string;
  score: number;
}

export interface PipelineRunResult {
  id: number;
  pdfId: number;
  finalScore: number;
  label: string;
  stageScores: StageScore[];
  startedAt: string;
  finishedAt: string;
  promptResults: PromptResult[];
}

/* ---------- Helfer ------------------------------------------------------ */

/** Leeres Grundgerüst für einen neuen Editor‑State. */
export const emptyPipeline = (): PipelineGraph => ({
  nodes: [],
  edges: [],
  stages: [],
  finalScoring: { scoreFormula: '', labelRules: [] },
});
