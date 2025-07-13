import React, { createContext, useContext, useEffect, useState } from 'react';

interface Ctx {
  unread: number;
  refresh: () => void;
  markAllRead: (ids: number[]) => void;
}

const PromptNotificationContext = createContext<Ctx>({
  unread: 0,
  refresh: () => {},
  markAllRead: () => {},
});

export function PromptNotificationProvider({ children }: { children: React.ReactNode }) {
  const [unread, setUnread] = useState(0);

  const fetchData = async () => {
    try {
      const res = await fetch('http://localhost:8082/prompts');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      const seen = JSON.parse(localStorage.getItem('seenPromptIds') || '[]') as number[];
      const unseen = (json as { id: number }[]).map(p => p.id).filter(id => !seen.includes(id));
      setUnread(unseen.length);
    } catch (err) {
      console.error('load prompts', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const markAllRead = (ids: number[]) => {
    localStorage.setItem('seenPromptIds', JSON.stringify(ids));
    setUnread(0);
  };

  return (
    <PromptNotificationContext.Provider value={{ unread, refresh: fetchData, markAllRead }}>
      {children}
    </PromptNotificationContext.Provider>
  );
}

export const usePromptNotifications = () => useContext(PromptNotificationContext);
