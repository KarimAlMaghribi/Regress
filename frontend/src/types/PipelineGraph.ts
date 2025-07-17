import { z } from 'zod';

export const PromptNodeSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(['TriggerPrompt', 'AnalysisPrompt', 'FollowUpPrompt', 'DecisionPrompt', 'FinalPrompt', 'MetaPrompt']),
  weight: z.number().optional(),
  confidenceThreshold: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});
export type PromptNode = z.infer<typeof PromptNodeSchema>;

export const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  condition: z.string().optional(),
  type: z.enum(['always', 'onTrue', 'onFalse', 'onScore', 'onError']).optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const StageSchema = z.object({
  id: z.string(),
  name: z.string(),
  promptIds: z.array(z.string()),
  scoreFormula: z.string().optional(),
});
export type Stage = z.infer<typeof StageSchema>;

export const FinalScoringSchema = z.object({
  scoreFormula: z.string(),
  labelRules: z.array(z.object({ if: z.string(), label: z.string() })),
});
export type FinalScoring = z.infer<typeof FinalScoringSchema>;

export const PipelineGraphSchema = z.object({
  nodes: z.array(PromptNodeSchema),
  edges: z.array(EdgeSchema),
  stages: z.array(StageSchema),
  finalScoring: FinalScoringSchema,
});
export type PipelineGraph = z.infer<typeof PipelineGraphSchema>;

export const examplePipeline: PipelineGraph = {
  nodes: [
    {
      id: 'trigger_1',
      text: 'Ist ein neuer Bericht eingegangen?',
      type: 'TriggerPrompt',
    },
    {
      id: 'analysis_1',
      text: 'Analysiere das Verhalten des Patienten.',
      type: 'AnalysisPrompt',
      weight: 1.2,
    },
    {
      id: 'analysis_2',
      text: 'Erfasse medizinische Parameter.',
      type: 'AnalysisPrompt',
      weight: 0.8,
    },
    {
      id: 'decision_1',
      text: 'Liegt ein Regress vor?',
      type: 'DecisionPrompt',
      confidenceThreshold: 0.7,
    },
    {
      id: 'final_1',
      text: 'Endgültiger Ergebnisbericht.',
      type: 'FinalPrompt',
    },
  ],
  edges: [
    { source: 'trigger_1', target: 'analysis_1', type: 'always' },
    { source: 'analysis_1', target: 'analysis_2', type: 'always' },
    { source: 'analysis_2', target: 'decision_1', type: 'always' },
    { source: 'decision_1', target: 'final_1', condition: 'result == true', type: 'onTrue' },
  ],
  stages: [
    {
      id: 'verhalten',
      name: 'Verhaltensanalyse',
      promptIds: ['analysis_1', 'analysis_2'],
      scoreFormula: 'sum(weightedResults) / totalWeight',
    },
  ],
  finalScoring: {
    scoreFormula: '0.4 * medizin.score + 0.6 * verhalten.score',
    labelRules: [
      { if: 'score >= 0.8', label: 'KEIN_REGRESS' },
      { if: 'score >= 0.5 && score < 0.8', label: 'MÖGLICHER_REGRESS' },
      { if: 'score < 0.5', label: 'SICHER_REGRESS' },
    ],
  },
};
