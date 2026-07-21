import type { ModelInfo, UploadResponse, JobSummary, JobDetailResponse, SampleAudio } from '../types';

const BASE_URL = (import.meta.env.VITE_API_ENDPOINT ?? '').replace(/\/+$/, '');

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? `Request failed with status ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export async function getModels(token: string): Promise<ModelInfo[]> {
  return request<ModelInfo[]>('/models', token);
}

export async function requestUploadUrl(
  token: string,
  fileName: string,
  fileSize: number,
  contentType: string,
): Promise<UploadResponse> {
  return request<UploadResponse>('/uploads', token, {
    method: 'POST',
    body: JSON.stringify({ fileName, fileSize, contentType }),
  });
}

export async function createJob(
  token: string,
  s3Key: string,
  modelIds: string[],
  groundTruthS3Key?: string,
): Promise<{ jobId: string; status: string; createdAt: string }> {
  return request<{ jobId: string; status: string; createdAt: string }>('/jobs', token, {
    method: 'POST',
    body: JSON.stringify({ s3Key, modelIds, ...(groundTruthS3Key && { groundTruthS3Key }) }),
  });
}

export async function getJobs(
  token: string,
  cursor?: string,
  limit?: number,
): Promise<{ jobs: JobSummary[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request<{ jobs: JobSummary[]; nextCursor?: string }>(`/jobs${qs ? `?${qs}` : ''}`, token);
}

export async function getJobDetail(token: string, jobId: string): Promise<JobDetailResponse> {
  return request<JobDetailResponse>(`/jobs/${encodeURIComponent(jobId)}`, token);
}

export async function deleteJob(token: string, jobId: string): Promise<void> {
  await request<{ message: string }>(`/jobs/${encodeURIComponent(jobId)}`, token, {
    method: 'DELETE',
  });
}

export async function getSampleAudio(token: string): Promise<SampleAudio[]> {
  return request<SampleAudio[]>('/samples', token);
}
