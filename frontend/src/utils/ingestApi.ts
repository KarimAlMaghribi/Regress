import axios from 'axios';
import {normalizeIngestBase} from './normalizeIngestBase';
import {
  CreateJobsRequest,
  CreateJobsResponse,
  FolderListResponse,
  JobActionResponse,
  JobsResponse,
  ProcessedFoldersResponse,
  ProcessedRunResponse,
  AggregatedJobsResponse,
} from '../types/ingest';

type RuntimeEnv = {
  SHAREPOINT_INGEST_URL?: string;
  SHAREPOINT_INGEST_API_URL?: string;
  INGEST_URL?: string;
  INGEST_API_URL?: string;
  INGEST_POLL_MS?: string;
};

const runtimeEnv: RuntimeEnv =
    (typeof window !== 'undefined' &&
        ((window as unknown as { __ENV__?: RuntimeEnv }).__ENV__ ?? {})) ||
    {};

const pickFirst = <T extends string>(...values: Array<T | undefined | null | false>): T | undefined => {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
};

const resolveDefaultSharePointBase = (): string => {
  const location =
      typeof window !== 'undefined' && window.location ? window.location : undefined;
  const protocol = location?.protocol && location.protocol !== ':' ? location.protocol : 'http:';
  const host = location?.hostname && location.hostname.length > 0 ? location.hostname : 'localhost';

  const normalizeHost = (value: string): string => {
    if (value.includes(':') && !value.startsWith('[')) {
      return `[${value}]`;
    }
    return value;
  };

  return `${protocol}//${normalizeHost(host)}:8080/ingest`;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const ensureSharePointPath = (path: string): string => {
  const trimmed = stripTrailingSlash(path);
  if (trimmed === '' || trimmed === '/' || !trimmed.startsWith('/ingest')) {
    return '/ingest';
  }
  return trimmed;
};

export const normalizeSharePointBase = (value: string | undefined): string | undefined => {
  const normalized = normalizeIngestBase(value);
  if (!normalized) return normalized;

  if (normalized.startsWith('/')) {
    return ensureSharePointPath(normalized);
  }

  try {
    const url = new URL(normalized);
    const normalizedPath = ensureSharePointPath(url.pathname || '');
    url.pathname = normalizedPath;

    return stripTrailingSlash(url.toString());
  } catch {
    return normalized;
  }
};

const sharePointCandidateRaw = pickFirst(
    runtimeEnv.SHAREPOINT_INGEST_URL,
    runtimeEnv.SHAREPOINT_INGEST_API_URL,
    import.meta.env.VITE_SHAREPOINT_INGEST_API_BASE as string | undefined,
    import.meta.env.VITE_SHAREPOINT_INGEST_URL as string | undefined,
    import.meta.env.VITE_SHAREPOINT_INGEST_API_URL as string | undefined,
);
const sharePointCandidate = normalizeSharePointBase(sharePointCandidateRaw);

const fallbackCandidateRaw = pickFirst(
    runtimeEnv.INGEST_URL,
    runtimeEnv.INGEST_API_URL,
    import.meta.env.VITE_INGEST_API_BASE as string | undefined,
    import.meta.env.VITE_INGEST_URL as string | undefined,
    import.meta.env.VITE_INGEST_API_URL as string | undefined,
    '/ingest',
);
const fallbackCandidate = normalizeSharePointBase(fallbackCandidateRaw);

const resolveCandidate = (): string | undefined => {
  if (sharePointCandidate) {
    return sharePointCandidate;
  }

  if (!fallbackCandidate) {
    return undefined;
  }

  const looksLikePdfIngest = (value: string): boolean => {
    if (!value || value.startsWith('/')) {
      return false;
    }

    try {
      const url = new URL(value, 'http://placeholder');
      const hostname = url.hostname.toLowerCase();
      const port = url.port;
      const path = url.pathname || '/';
      if (hostname.includes('pdf-ingest')) {
        return true;
      }
      if (port === '8081' && (path === '/' || path === '')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  if (fallbackCandidateRaw && looksLikePdfIngest(fallbackCandidateRaw)) {
    return undefined;
  }

  return fallbackCandidate;
};

const normalizedCandidate = resolveCandidate();

const BASE_URL = normalizedCandidate || normalizeSharePointBase(resolveDefaultSharePointBase()) || '/ingest';

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const pollRaw = Number(
    runtimeEnv.INGEST_POLL_MS ??
    (import.meta.env.VITE_INGEST_POLL_MS as string | undefined) ??
    '3000',
);
export const INGEST_POLL_INTERVAL = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 3000;

export async function fetchFolders() {
  const { data } = await client.get<FolderListResponse>('folders');
  return data;
}

export async function createJobs(payload: CreateJobsRequest) {
  const { data } = await client.post<CreateJobsResponse>('jobs', payload);
  return data;
}

export async function fetchJobs() {
  const { data } = await client.get<JobsResponse>('jobs');
  return data;
}

export async function triggerJobAction(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  const { data } = await client.post<JobActionResponse>(`jobs/${jobId}/${action}`);
  return data;
}

export async function fetchProcessedFolders(params?: {stage?: 'pending' | 'completed' | 'finished' | 'all'}) {
  const { data } = await client.get<ProcessedFoldersResponse>('processed-folders', {params});
  return data;
}

export async function runProcessedFolders(payload: { job_ids: string[]; pipeline_id: string }) {
  const { data } = await client.post<ProcessedRunResponse>('processed-folders/run', payload);
  return data;
}

export async function fetchAggregatedJobs() {
  const { data } = await client.get<AggregatedJobsResponse>('jobs/all');
  return data;
}

export default client;
