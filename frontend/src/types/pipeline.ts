export interface TextPosition {
  page: number;
  bbox: [number, number, number, number];
}

export interface PromptResult {
  prompt_id: number;
  prompt_type: 'ExtractionPrompt' | 'ScoringPrompt' | 'DecisionPrompt';
  prompt_text: string;
  score?: number;
  boolean?: boolean;
  route?: string;
  source?: TextPosition;
  openaiRaw: string;
}

export interface PipelineRunResult {
  pdfId: number;
  pipelineId: string;
  summary: string;
  extraction: PromptResult[];
  scoring: PromptResult[];
  decision: PromptResult[];
}
