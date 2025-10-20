type RuntimeEnv = {
  PIPELINE_API_URL?: string;
  API_URL?: string;
  INGEST_URL?: string;
  INGEST_API_URL?: string;
  UPLOAD_API_URL?: string;
  UPLOAD_URL?: string;
};

const runtimeEnv: RuntimeEnv =
    (typeof window !== 'undefined' &&
        ((window as unknown as { __ENV__?: RuntimeEnv }).__ENV__ ?? {})) ||
    {};

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) || {};

const pickFirst = <T extends string>(...values: Array<T | undefined | null | false>): T | undefined => {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
};

const API_BASE =
    pickFirst(
        runtimeEnv.PIPELINE_API_URL,
        runtimeEnv.API_URL,
        env.VITE_PIPELINE_API_URL,
        env.VITE_API_URL,
    ) || 'http://localhost:8084';

const INGEST_API =
    pickFirst(
        runtimeEnv.INGEST_URL,
        runtimeEnv.INGEST_API_URL,
        env.VITE_INGEST_API_BASE,
        env.VITE_INGEST_URL,
        '/ingest',
    ) || 'http://localhost:8081';

const UPLOAD_API =
    pickFirst(
        runtimeEnv.UPLOAD_API_URL,
        runtimeEnv.UPLOAD_URL,
        runtimeEnv.INGEST_URL,
        runtimeEnv.INGEST_API_URL,
        env.VITE_INGEST_API_BASE,
        env.VITE_INGEST_URL,
        env.VITE_UPLOAD_API_URL,
        '/ingest',
    ) || 'http://localhost:8081';

export {API_BASE, INGEST_API, UPLOAD_API};
