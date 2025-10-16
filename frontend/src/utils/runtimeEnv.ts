type RuntimeEnv = {
  UPLOAD_API_URL?: string;
  INGEST_URL?: string;
};

function getRuntimeEnv(): RuntimeEnv {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as { __ENV__?: RuntimeEnv };
  return w.__ENV__ || {};
}

export function getUploadApiBase(): string {
  const runtime = getRuntimeEnv();
  return (
    runtime.UPLOAD_API_URL ||
    runtime.INGEST_URL ||
    (import.meta.env.VITE_UPLOAD_API_URL as string | undefined) ||
    (import.meta.env.VITE_INGEST_URL as string | undefined) ||
    'http://localhost:8081'
  );
}

