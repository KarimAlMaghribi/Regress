export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type FolderAutomationSummary = Readonly<{
  tenant_id?: string | null;
  pipeline_id?: string | null;
  auto_ingest: boolean;
  auto_pipeline: boolean;
  last_seen?: string | null;
  updated_at?: string | null;
}>;

export interface FolderSummary {
  id: string;
  name: string;
  file_count: number;
  automation?: FolderAutomationSummary;
  automation_source?: 'folder' | 'default';
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
  pipeline_run_id?: string | null;
  upload_id?: number | null;
  pdf_id?: number | null;
  auto_managed: boolean;
  auto_last_seen_at?: string | null;
}

export interface JobsResponse {
  jobs: JobSummary[];
}

export interface ProcessedFolderSummary {
  job_id: string;
  folder_id: string;
  folder_name: string;
  status: JobStatus;
  progress: number;
  message?: string | null;
  tenant_id?: string | null;
  pipeline_id?: string | null;
  pipeline_run_id?: string | null;
  upload_id?: number | null;
  pdf_id?: number | null;
  upload_status?: string | null;
  pipeline_status?: string | null;
  pipeline_status_category?: JobStatus | null;
  pipeline_progress?: number | null;
  pipeline_error?: string | null;
  pipeline_started_at?: string | null;
  pipeline_finished_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProcessedFoldersResponse {
  items: ProcessedFolderSummary[];
}

export interface ProcessedRunStarted {
  job_id: string;
  upload_id: number;
  pdf_id?: number | null;
  pipeline_id: string;
}

export interface ProcessedRunSkipped {
  job_id: string;
  reason: string;
}

export interface ProcessedRunResponse {
  started: ProcessedRunStarted[];
  skipped: ProcessedRunSkipped[];
}

export type AggregatedJobSource = 'sharepoint' | 'pipeline';

export interface AggregatedJobEntry {
  id: string;
  source: AggregatedJobSource;
  status: string;
  status_category: JobStatus;
  progress: number;
  message?: string | null;
  folder_name?: string | null;
  pipeline_name?: string | null;
  sharepoint_job_id?: string | null;
  pipeline_id?: string | null;
  pdf_id?: number | null;
  upload_id?: number | null;
  created_at: string;
  updated_at?: string | null;
}

export interface AggregatedJobsResponse {
  jobs: AggregatedJobEntry[];
}

export interface CreateJobsRequest {
  folder_ids: string[];
  order?: JobOrder;
  filenames?: Record<string, string[]>;
  tenant_id?: string;
  upload_url?: string;
  pipeline_id?: string;
}

export type AutomationScope = 'ingest' | 'processing';

interface AutomationDefaultBase<S extends AutomationScope> {
  scope: S;
  enabled: boolean;
  tenant_id?: string | null;
  updated_at: string;
}

export type AutomationDefaultSettings =
  | (AutomationDefaultBase<'ingest'> & {pipeline_id?: null})
  | (AutomationDefaultBase<'processing'> & {pipeline_id?: string | null});

export interface AutomationDefaultsResponse {
  items: AutomationDefaultSettings[];
}

export type AutomationDefaultUpdate<S extends AutomationScope = AutomationScope> = S extends 'processing'
  ? {
      enabled: boolean;
      tenant_id?: string | null;
      pipeline_id?: string | null;
    }
  : {
      enabled: boolean;
      tenant_id?: string | null;
    };

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
