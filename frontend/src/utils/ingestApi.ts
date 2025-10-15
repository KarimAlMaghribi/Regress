import axios from 'axios';
import {
  CreateJobsRequest,
  CreateJobsResponse,
  FolderListResponse,
  JobActionResponse,
  JobsResponse,
} from '../types/ingest';

type RuntimeEnv = {
  INGEST_API_URL?: string;
  INGEST_ADMIN_TOKEN?: string;
  INGEST_POLL_MS?: string;
};

const runtimeEnv: RuntimeEnv =
  (typeof window !== 'undefined' &&
    ((window as unknown as { __ENV__?: RuntimeEnv }).__ENV__ ?? {})) ||
  {};

const BASE_URL =
  (import.meta.env.VITE_INGEST_API_BASE as string | undefined) ||
  runtimeEnv.INGEST_API_URL ||
  '/ingest';

const ADMIN_TOKEN =
  (import.meta.env.VITE_INGEST_ADMIN_TOKEN as string | undefined) ||
  runtimeEnv.INGEST_ADMIN_TOKEN;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use((config) => {
  if (ADMIN_TOKEN) {
    config.headers = config.headers ?? {};
    if (!config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
    }
  }
  return config;
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
