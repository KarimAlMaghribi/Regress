import { useEffect, useState } from 'react';

export type Tenant = { id: string; name: string };

export function useTenants() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/tenants');
      if (!res.ok) throw new Error(await res.text());
      setItems(await res.json());
    } catch (e: any) {
      setError(e.message || 'Fehler beim Laden der Mandanten');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  return { items, loading, error, reload: load };
}
