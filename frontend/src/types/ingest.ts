export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface FolderSummary {
  id: string;
  name: string;
  file_count: number;
}

export interface FolderListResponse {
  base: string;
  total: number;
  items: FolderSummary[];
}

export type JobOrder = 'alpha' | 'name_asc' | 'name_desc';

export interface JobSummary {
  id: string;
  folder_id: string;
  folder_name: string;
  status: JobStatus;
  progress: number;
  message?: string | null;
  output?: unknown;
}

export interface JobsResponse {
  jobs: JobSummary[];
}

export interface CreateJobsRequest {
  folder_ids: string[];
  order?: JobOrder;
  filenames?: Record<string, string[]>;
}

export interface CreateJobsResponse {
  jobs: JobSummary[];
}

export interface JobActionResponse {
  job?: JobSummary;
}
