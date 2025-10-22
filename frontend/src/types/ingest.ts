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

export interface UploadResultSummary {
  status: string;
  response: unknown;
  uploaded_at: string;
  upload_id?: number | null;
  pdf_id?: number | null;
}

export interface JobSummary {
  id: string;
  folder_id: string;
  folder_name: string;
  status: JobStatus;
  progress: number;
  message?: string | null;
  output?: UploadResultSummary;
  tenant_id?: string | null;
  upload_url?: string | null;
  pipeline_id?: string | null;
  upload_id?: number | null;
  pdf_id?: number | null;
}

export interface JobsResponse {
  jobs: JobSummary[];
}

export interface CreateJobsRequest {
  folder_ids: string[];
  order?: JobOrder;
  filenames?: Record<string, string[]>;
  tenant_id?: string;
  upload_url?: string;
}

export interface UploadListEntry {
  id: number;
  pdf_id: number | null;
  status: string;
  names?: string[];
}

export interface CreateJobsResponse {
  jobs: JobSummary[];
}

export interface JobActionResponse {
  job?: JobSummary;
}
