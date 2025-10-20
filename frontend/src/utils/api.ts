import {resolveDefaultIngestBase} from './defaultIngestUrl';

type RuntimeEnv = {
  PIPELINE_API_URL?: string;
  API_URL?: string;
  PDF_INGEST_URL?: string;
  PDF_INGEST_API_URL?: string;
  INGEST_URL?: string;
  INGEST_API_URL?: string;
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

const PDF_INGEST_API =
    pickFirst(
        runtimeEnv.PDF_INGEST_URL,
        runtimeEnv.PDF_INGEST_API_URL,
        runtimeEnv.INGEST_URL,
        runtimeEnv.INGEST_API_URL,
        env.VITE_PDF_INGEST_API_BASE,
        env.VITE_PDF_INGEST_URL,
        env.VITE_PDF_INGEST_API_URL,
        env.VITE_INGEST_API_BASE,
        env.VITE_INGEST_URL,
        env.VITE_INGEST_API_URL,
        '',
    ) || resolveDefaultIngestBase();

const INGEST_API = PDF_INGEST_API;

export {API_BASE, INGEST_API};
