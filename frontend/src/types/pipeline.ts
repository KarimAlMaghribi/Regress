export interface TextPosition {
  page: number;
  bbox: [number, number, number, number];
  quote?: string;
}

export interface PromptResult {
  prompt_id: number;
  prompt_type: 'ExtractionPrompt' | 'ScoringPrompt' | 'DecisionPrompt';
  prompt_text: string;
  boolean?: boolean;
  value?: any;
  weight?: number;
  route?: string;
  json_key?: string;
  error?: string;
  source?: TextPosition;
  openaiRaw: string;
}

export interface PipelineRunResult {
  pdfId: number;
  pipelineId: string;
  overallScore?: number;
  extracted: Record<string, any>;
  extraction: PromptResult[];
  scoring: PromptResult[];
  decision: PromptResult[];
}
