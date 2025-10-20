import axios from 'axios';
import {
  CreateJobsRequest,
  CreateJobsResponse,
  FolderListResponse,
  JobActionResponse,
  JobsResponse,
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

const BASE_URL =
    pickFirst(
        runtimeEnv.SHAREPOINT_INGEST_URL,
        runtimeEnv.SHAREPOINT_INGEST_API_URL,
        runtimeEnv.INGEST_URL,
        runtimeEnv.INGEST_API_URL,
        import.meta.env.VITE_SHAREPOINT_INGEST_API_BASE as string | undefined,
        import.meta.env.VITE_SHAREPOINT_INGEST_URL as string | undefined,
        import.meta.env.VITE_INGEST_API_BASE as string | undefined,
        import.meta.env.VITE_INGEST_URL as string | undefined,
        '/ingest',
    ) || 'http://localhost:8080';

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
  const { data } = await client.get<FolderListResponse>('/folders');
  return data;
}

export async function createJobs(payload: CreateJobsRequest) {
  const { data } = await client.post<CreateJobsResponse>('/jobs', payload);
  return data;
}

export async function fetchJobs() {
  const { data } = await client.get<JobsResponse>('/jobs');
  return data;
}

export async function triggerJobAction(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  const { data } = await client.post<JobActionResponse>(`/jobs/${jobId}/${action}`);
  return data;
}

export default client;
