// ---------------------------------------------------------------------------
//  src/store/usePipelineStore.ts
//  --------------------------------------------------------------------------
//  Globaler Editor‑State für Prompt‑Pipelines.
//  – Speichert das PipelineGraph‑Objekt    (siehe '@/types/pipeline')
//  – Liefert Live‑Validierungs-Errors      (Zod + custom cycle‑check)
//  – Stellt CRUD‑Aktionen für Nodes/Edges  (add, update, remove)
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { z } from 'zod';

import type {
  PipelineGraph,
  PromptNode,
  Edge,
  PromptType,
  UUID,
} from '@/types/pipeline';
import { emptyPipeline } from '@/types/pipeline';

/* -----------------------------------------------------------------------
 * 1. Zod‑Schema  (Basisvalidierung – referenzielle Checks kommen separat)
 * --------------------------------------------------------------------- */
const NodeSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  type: z.enum([
    'TriggerPrompt',
    'AnalysisPrompt',
    'FollowUpPrompt',
    'DecisionPrompt',
    'FinalPrompt',
    'MetaPrompt',
  ]),
  weight: z.number().optional(),
  confidenceThreshold: z.number().optional(),
  metadata: z.any().optional(),
});

const EdgeSchema = z.object({
  id: z.string().uuid(),
  source: z.string().uuid(),
  target: z.string().uuid(),
  type: z.enum(['always', 'onTrue', 'onFalse', 'onScore', 'onError']),
  condition: z.string().optional(),
});

const PipelineSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  stages: z.any(),        // Detail‑Check später
  finalScoring: z.any(),  // "
});

/* -----------------------------------------------------------------------
 * 2. Helper – Zyklusdetektor (Kahn‑Algo im Kleinformat)
 * --------------------------------------------------------------------- */
const hasCycle = (nodes: PromptNode[], edges: Edge[]): boolean => {
  const inDeg = new Map<UUID, number>();
  nodes.forEach(n => inDeg.set(n.id, 0));
  edges.forEach(e => inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1));

  const q: UUID[] = [...inDeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = 0;
  while (q.length) {
    const n = q.shift()!;
    visited++;
    edges
    .filter(e => e.source === n)
    .forEach(e => {
      const d = (inDeg.get(e.target) ?? 0) - 1;
      inDeg.set(e.target, d);
      if (d === 0) q.push(e.target);
    });
  }
  return visited !== nodes.length;
};

/* -----------------------------------------------------------------------
 * 3. State‑Definition
 * --------------------------------------------------------------------- */
interface PipelineState {
  pipeline: PipelineGraph;
  validationErrors: string[];

  /* Selection – kann der UI helfen (Edge‑Drawer …) */
  selectedNodeIds: UUID[];

  /* Actions ----------------------------------------------------------- */
  addNode: (node: Omit<PromptNode, 'id'> & { id?: UUID }) => void;
  updateNode: (id: UUID, patch: Partial<Omit<PromptNode, 'id'>>) => void;
  removeNode: (id: UUID) => void;

  addEdge: (edge: Omit<Edge, 'id'> & { id?: UUID }) => void;
  removeEdge: (id: UUID) => void;

  setFinalFormula: (formula: string) => void;

  validate: () => void;
}

/* -----------------------------------------------------------------------
 * 4. Store‑Implementierung  (Zustand + Immer‑Mutations)
 * --------------------------------------------------------------------- */
export const usePipelineStore = create<PipelineState>()(
    immer((set, get) => ({
      pipeline: emptyPipeline(),
      validationErrors: [],
      selectedNodeIds: [],

      /* ------------ Nodes -------------------------------------------- */
      addNode(node) {
        const newNode: PromptNode = { id: crypto.randomUUID(), ...node };
        set(draft => {
          draft.pipeline.nodes.push(newNode);
        });
        get().validate();
      },
      updateNode(id, patch) {
        set(draft => {
          const n = draft.pipeline.nodes.find(n => n.id === id);
          if (n) Object.assign(n, patch);
        });
        get().validate();
      },
      removeNode(id) {
        set(draft => {
          draft.pipeline.nodes = draft.pipeline.nodes.filter(n => n.id !== id);
          draft.pipeline.edges = draft.pipeline.edges.filter(
              e => e.source !== id && e.target !== id,
          );
        });
        get().validate();
      },

      /* ------------ Edges -------------------------------------------- */
      addEdge(edge) {
        const newEdge: Edge = {
          id: crypto.randomUUID(),
          type: 'always',
          ...edge,
        };
        set(draft => {
          draft.pipeline.edges.push(newEdge);
        });
        get().validate();
      },
      removeEdge(id) {
        set(draft => {
          draft.pipeline.edges = draft.pipeline.edges.filter(e => e.id !== id);
        });
        get().validate();
      },

      /* ------------ Final Scoring ------------------------------------ */
      setFinalFormula(formula) {
        set(draft => {
          draft.pipeline.finalScoring.scoreFormula = formula;
        });
        get().validate();
      },

      /* ------------ Validation --------------------------------------- */
      validate() {
        const { pipeline } = get();
        const errs: string[] = [];

        /* Zod‑Struktur‑Check */
        const zRes = PipelineSchema.safeParse(pipeline);
        if (!zRes.success) {
          zRes.error.errors.forEach(e => errs.push(e.message));
        }

        /* Domain‑Checks */
        if (
            pipeline.nodes.filter(n => n.type === 'TriggerPrompt').length !== 1
        ) {
          errs.push('Genau ein TriggerPrompt erforderlich');
        }
        if (pipeline.nodes.filter(n => n.type === 'FinalPrompt').length !== 1) {
          errs.push('Genau ein FinalPrompt erforderlich');
        }
        if (hasCycle(pipeline.nodes, pipeline.edges)) {
          errs.push('Graph enthält einen Zyklus');
        }

        set({ validationErrors: errs });
      },
    })),
);
