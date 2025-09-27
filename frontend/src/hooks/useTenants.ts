import { useEffect, useState } from "react";

export type Tenant = { id: string; name: string };

function getHistoryBase(): string {
  const w = (window as any);
  return w?.__ENV__?.HISTORY_URL || import.meta.env.VITE_HISTORY_URL || "/hist";
}

export function useTenants() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getHistoryBase()}/tenants`);
      if (!res.ok) throw new Error(await res.text());
      setItems(await res.json());
    } catch (e: any) {
      setError(e.message || "Fehler beim Laden der Mandanten");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  return { items, loading, error, reload: load };
}
