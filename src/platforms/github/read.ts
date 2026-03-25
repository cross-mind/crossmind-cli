/**
 * GitHub read operations.
 * Uses REST API v3. Auth token optional (higher rate limits when provided).
 */

import { request } from '../../http/client.js';
import { getGitHubToken, githubHeaders, GITHUB_API } from '../../auth/github.js';

export interface GHRepo {
  rank: number;
  name: string;
  full_name: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  url: string;
  topics: string;
}

export interface GHIssue {
  rank: number;
  number: number;
  title: string;
  state: string;
  labels: string;
  comments: number;
  author: string;
  created_at: string;
  url: string;
}

export interface GHRelease {
  rank: number;
  tag: string;
  name: string;
  published_at: string;
  url: string;
}

/** Search GitHub repositories */
export async function searchRepos(
  query: string,
  sort: 'stars' | 'forks' | 'updated' | 'best-match',
  limit: number,
  account?: string,
  dataDir?: string
): Promise<GHRepo[]> {
  const token = await getGitHubToken(account, dataDir);
  // GitHub search requires colons in qualifiers (e.g. language:python) to remain unencoded.
  const q = encodeURIComponent(query).replace(/%3A/gi, ':');
  const url = `${GITHUB_API}/search/repositories?q=${q}&sort=${sort}&per_page=${Math.min(limit, 100)}`;
  const data = await request<{ items: Record<string, unknown>[] }>(url, {
    headers: githubHeaders(token),
  });

  return data.items.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    name: String(r['name'] ?? ''),
    full_name: String(r['full_name'] ?? ''),
    description: String(r['description'] ?? '').slice(0, 120),
    language: String(r['language'] ?? ''),
    stars: Number(r['stargazers_count'] ?? 0),
    forks: Number(r['forks_count'] ?? 0),
    url: String(r['html_url'] ?? ''),
    topics: ((r['topics'] as string[]) ?? []).slice(0, 5).join(','),
  }));
}

/** Get trending repos (approximated via search) */
export async function trendingRepos(
  language: string,
  period: 'daily' | 'weekly' | 'monthly',
  limit: number,
  account?: string,
  dataDir?: string
): Promise<GHRepo[]> {
  const days = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const langFilter = language ? ` language:${language}` : '';
  const query = `created:>${since}${langFilter}`;
  return searchRepos(query, 'stars', limit, account, dataDir);
}

/** List issues for a repository */
export async function listIssues(
  repo: string,
  state: 'open' | 'closed' | 'all',
  limit: number,
  account?: string,
  dataDir?: string
): Promise<GHIssue[]> {
  const token = await getGitHubToken(account, dataDir);
  const url = `${GITHUB_API}/repos/${repo}/issues?state=${state}&per_page=${Math.min(limit, 100)}&sort=updated`;
  const data = await request<Record<string, unknown>[]>(url, {
    headers: githubHeaders(token),
  });

  return data.slice(0, limit).map((issue, i) => ({
    rank: i + 1,
    number: Number(issue['number'] ?? 0),
    title: String(issue['title'] ?? ''),
    state: String(issue['state'] ?? ''),
    labels: ((issue['labels'] as Array<{ name: string }>) ?? []).map((l) => l.name).join(','),
    comments: Number(issue['comments'] ?? 0),
    author: String((issue['user'] as { login: string } | null)?.login ?? ''),
    created_at: String(issue['created_at'] ?? '').slice(0, 10),
    url: String(issue['html_url'] ?? ''),
  }));
}

/** List releases for a repository */
export async function listReleases(
  repo: string,
  limit: number,
  account?: string,
  dataDir?: string
): Promise<GHRelease[]> {
  const token = await getGitHubToken(account, dataDir);
  const url = `${GITHUB_API}/repos/${repo}/releases?per_page=${Math.min(limit, 100)}`;
  const data = await request<Record<string, unknown>[]>(url, {
    headers: githubHeaders(token),
  });

  return data.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    tag: String(r['tag_name'] ?? ''),
    name: String(r['name'] ?? ''),
    published_at: String(r['published_at'] ?? '').slice(0, 10),
    url: String(r['html_url'] ?? ''),
  }));
}
