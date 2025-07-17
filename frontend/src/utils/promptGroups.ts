export interface Prompt {
  id: number;
  text: string;
}

export interface PromptGroup {
  id: number;
  name: string;
  prompt_ids: number[];
}

export async function loadPromptGroupMap(): Promise<Record<string, string[]>> {
  const base =
    import.meta.env.VITE_PROMPT_MANAGER_URL || 'http://localhost:8082';
  const [prompts, groups] = await Promise.all([
    fetch(`${base}/prompts`).then(r => r.json()).catch(() => []),
    fetch(`${base}/prompt-groups`).then(r => r.json()).catch(() => []),
  ]);
  const textById: Record<number, string> = {};
  (prompts as any[]).forEach(p => {
    textById[p.id] = p.text;
  });
  const map: Record<string, string[]> = {};
  (groups as any[]).forEach(g => {
    (g.prompt_ids as number[]).forEach((id: number) => {
      const text = textById[id];
      if (text) {
        map[text] = map[text] || [];
        map[text].push(g.name);
      }
    });
  });
  return map;
}
