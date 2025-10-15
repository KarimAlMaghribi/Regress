import {
  CreateJobsRequest,
  CreateJobsResponse,
  FolderListResponse,
  JobActionResponse,
  JobsResponse,
} from '../types/ingest';

const BASE_URL = (import.meta.env.VITE_INGEST_API_BASE as string | undefined) || 'http://localhost:8080';
const ADMIN_TOKEN = import.meta.env.VITE_INGEST_ADMIN_TOKEN as string | undefined;

export class HttpError extends Error {
  status?: number;
  data?: unknown;

  constructor(message: string, options: { status?: number; data?: unknown } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status;
    this.data = options.data;
  }
}

function buildHeaders(init: RequestInit) {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (ADMIN_TOKEN && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  }
  return headers;
}

async function requestJson<T>(path: string, init: RequestInit = {}) {
  const headers = buildHeaders(init);
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await response.text();

  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    let message = response.statusText || `Request failed with status ${response.status}`;
    if (typeof data === 'string' && data.trim().length > 0) {
      message = data;
    } else if (data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string') {
      message = (data as { message: string }).message;
    }
    throw new HttpError(message, { status: response.status, data });
  }

  return data as T;
}

const pollRaw = Number(import.meta.env.VITE_INGEST_POLL_MS ?? '3000');
export const INGEST_POLL_INTERVAL = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 3000;

export async function fetchFolders() {
  return requestJson<FolderListResponse>('/folders');
}

export async function createJobs(payload: CreateJobsRequest) {
  return requestJson<CreateJobsResponse>('/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchJobs() {
  return requestJson<JobsResponse>('/jobs');
}

export async function triggerJobAction(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  return requestJson<JobActionResponse>(`/jobs/${jobId}/${action}`, {
    method: 'POST',
  });
}
