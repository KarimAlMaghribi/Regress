import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface EvaluationResult {
  correctness: number;
  relevance: number;
  completeness: number;
  notes?: string;
}

export interface RunMetricsResult {
  answer: string;
  answers: string[];
  evaluation: EvaluationResult;
  moderationFlags: string[];
  embeddingSimilarity: number;
  avgLogprob: number;
  bestOfChoice: 'A' | 'B' | 'C';
  totalTokens: number;
  cost: number;
}

const evaluateFunc = {
  name: 'evaluate_answer',
  parameters: {
    type: 'object',
    properties: {
      score: { type: 'number' },
      notes: { type: 'string' },
    },
    required: ['score', 'notes'],
  },
};

export async function runPromptWithMetrics(prompt: string, input: string): Promise<RunMetricsResult> {
  const baseMessages = [
    { role: 'system' as const, content: prompt },
    { role: 'user' as const, content: input },
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: baseMessages,
    logprobs: 1,
    n: 3,
  });
  const answers = completion.choices.map(c => c.message.content || '');

  const rankingPrompt = `Here are three answers (A, B, C). Which is best and why? Reply with {\"choice\": \"A\"|\"B\"|\"C\", \"reason\": \"...\"}.\nA: ${answers[0]}\nB: ${answers[1]}\nC: ${answers[2]}`;
  const ranking = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{ role: 'user', content: rankingPrompt }],
    response_format: { type: 'json_object' },
  });
  const rankJson = JSON.parse(ranking.choices[0].message.content || '{}');
  const bestIdx = { A: 0, B: 1, C: 2 }[rankJson.choice as 'A' | 'B' | 'C'] ?? 0;
  const bestAnswer = answers[bestIdx];

  const evalPrompt = `Evaluate the following answer for correctness, relevance and completeness (0-1 scale). Return JSON {correctness:number,relevance:number,completeness:number}`;
  const evaluation = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      { role: 'system', content: evalPrompt },
      { role: 'user', content: bestAnswer },
    ],
    response_format: { type: 'json_object' },
    functions: [evaluateFunc],
  });
  const evaluationJson: EvaluationResult = JSON.parse(evaluation.choices[0].message.content || '{}');

  const moderation = await openai.moderations.create({ input: bestAnswer });
  const moderationFlags = Object.entries(moderation.results[0].categories)
    .filter(([_, v]) => v)
    .map(([k]) => k);

  const promptEmbedding = await openai.embeddings.create({ input: prompt, model: 'text-embedding-3-small' });
  const answerEmbedding = await openai.embeddings.create({ input: bestAnswer, model: 'text-embedding-3-small' });
  const embeddingSimilarity = cosine(promptEmbedding.data[0].embedding, answerEmbedding.data[0].embedding);

  const lp = completion.choices[bestIdx].logprobs?.token_logprobs ?? [];
  const avgLogprob = lp.reduce((a, b) => a + (b ?? 0), 0) / Math.max(lp.length, 1);

  const totalTokens = completion.usage?.total_tokens ?? 0;
  const cost = totalTokens * 0.00001; // placeholder cost calc

  return {
    answer: bestAnswer,
    answers,
    evaluation: evaluationJson,
    moderationFlags,
    embeddingSimilarity,
    avgLogprob,
    bestOfChoice: rankJson.choice as 'A' | 'B' | 'C',
    totalTokens,
    cost,
  };
}

function cosine(a: number[], b: number[]) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (na * nb);
}
