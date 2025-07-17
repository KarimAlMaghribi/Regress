export interface PromptResult {
  promptId: string;
  promptType: string;
  status: string;
  result?: boolean;
  score?: number;
  answer?: string;
  source?: string;
  startedAt: string;
  finishedAt: string;
}

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
