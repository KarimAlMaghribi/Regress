import {resolveDefaultIngestBase} from './defaultIngestUrl';
import {normalizeIngestBase} from './normalizeIngestBase';

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

const pdfIngestCandidate = pickFirst(
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
);

const getWindowLocation = () => {
  if (typeof window === 'undefined') return undefined;
  const { location } = window;
  if (!location) return undefined;
  return location;
};

const stripTrailingSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

const enforcePdfPort = (value: string | undefined): string => {
  const windowLocation = getWindowLocation();
  const fallbackProtocol = windowLocation?.protocol || 'http:';
  const fallbackHost = windowLocation?.hostname || 'localhost';
  const fallbackBase = `${fallbackProtocol}//${fallbackHost}:8081`;

  if (!value) {
    return fallbackBase;
  }

  if (value.startsWith('/')) {
    return stripTrailingSlash(`${fallbackBase}${value}`);
  }

  try {
    const url = new URL(value, `${fallbackProtocol}//${fallbackHost}`);
    url.port = '8081';
    if (!url.protocol || url.protocol === ':') {
      url.protocol = fallbackProtocol;
    }
    return stripTrailingSlash(url.toString());
  } catch {
    return fallbackBase;
  }
};

const PDF_INGEST_API = normalizeIngestBase(pdfIngestCandidate) || resolveDefaultIngestBase();

const INGEST_API = PDF_INGEST_API;
const PDF_OPEN_BASE = enforcePdfPort(PDF_INGEST_API);

export {API_BASE, INGEST_API, PDF_OPEN_BASE};
