/**
 * GitHub App Client
 * Handles authentication and API calls for the error collector
 */

import type { GitHubIssueCreate, GitHubIssueUpdate, Env } from './types';

/**
 * Create a JWT for GitHub App authentication
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
async function createAppJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued 60 seconds ago to account for clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  // Import the private key
  const pemContent = privateKey
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Create JWT
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = btoa(JSON.stringify(header))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const data = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(data)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${signatureB64}`;
}

/**
 * Get an installation access token from the GitHub App
 */
async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string
): Promise<string> {
  const jwt = await createAppJWT(appId, privateKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Platform-Error-Collector/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

/**
 * GitHub API client with cached installation token
 */
export class GitHubClient {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(private env: Env) {}

  /**
   * Get a valid installation token, refreshing if needed
   */
  private async getToken(): Promise<string> {
    const now = Date.now();

    // Refresh token if expired or expiring in next 5 minutes
    if (!this.token || now > this.tokenExpiry - 5 * 60 * 1000) {
      // Decode base64 private key if needed
      let privateKey = this.env.GITHUB_APP_PRIVATE_KEY;
      if (!privateKey.includes('BEGIN')) {
        // It's base64 encoded
        privateKey = atob(privateKey);
      }

      this.token = await getInstallationToken(
        this.env.GITHUB_APP_ID,
        privateKey,
        this.env.GITHUB_APP_INSTALLATION_ID
      );
      // Installation tokens are valid for 1 hour
      this.tokenExpiry = now + 55 * 60 * 1000;
    }

    return this.token;
  }

  /**
   * Make an authenticated request to the GitHub API
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();

    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Platform-Error-Collector/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a new GitHub issue
   */
  async createIssue(params: GitHubIssueCreate): Promise<{ number: number; html_url: string }> {
    const payload: Record<string, unknown> = {
      title: params.title,
      body: params.body,
      labels: params.labels,
    };

    // Add issue type if specified (org must have issue types enabled)
    if (params.type) {
      payload.type = params.type;
    }

    // Add assignees if specified
    if (params.assignees?.length) {
      payload.assignees = params.assignees;
    }

    return this.request('POST', `/repos/${params.owner}/${params.repo}/issues`, payload);
  }

  /**
   * Update an existing GitHub issue
   */
  async updateIssue(params: GitHubIssueUpdate): Promise<{ number: number; html_url: string }> {
    const body: Record<string, unknown> = {};
    if (params.body !== undefined) body.body = params.body;
    if (params.state !== undefined) body.state = params.state;

    return this.request(
      'PATCH',
      `/repos/${params.owner}/${params.repo}/issues/${params.issue_number}`,
      body
    );
  }

  /**
   * Add a comment to an issue
   */
  async addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number }> {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body,
    });
  }

  /**
   * Add labels to an issue
   */
  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<void> {
    await this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      labels,
    });
  }

  /**
   * Add an issue to the GitHub Project board
   */
  async addToProject(issueNodeId: string, projectId: string): Promise<string> {
    const token = await this.getToken();

    const query = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item { id }
        }
      }
    `;

    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Platform-Error-Collector/1.0',
      },
      body: JSON.stringify({
        query,
        variables: { projectId, contentId: issueNodeId },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GraphQL error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      data?: { addProjectV2ItemById?: { item?: { id: string } } };
      errors?: Array<{ message: string }>;
    };

    if (data.errors?.length) {
      throw new Error(`GraphQL errors: ${data.errors.map((e) => e.message).join(', ')}`);
    }

    return data.data?.addProjectV2ItemById?.item?.id || '';
  }

  /**
   * Get issue by number to retrieve its node_id
   */
  async getIssue(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<{ node_id: string; state: string; labels?: Array<{ name: string } | string> }> {
    return this.request('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`);
  }

  /**
   * Search for issues using GitHub's search API.
   * Retries once on 403 (rate limit) with a 1s delay.
   * @see https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests
   */
  async searchIssues(
    owner: string,
    repo: string,
    query: string
  ): Promise<
    Array<{
      number: number;
      state: 'open' | 'closed';
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
    }>
  > {
    const fullQuery = `repo:${owner}/${repo} is:issue ${query}`;
    const path = `/search/issues?q=${encodeURIComponent(fullQuery)}&per_page=5`;

    try {
      const response = await this.request<{
        total_count: number;
        items: Array<{
          number: number;
          state: 'open' | 'closed';
          title: string;
          body: string | null;
          labels: Array<{ name: string }>;
        }>;
      }>('GET', path);
      return response.items || [];
    } catch (error) {
      // Retry once on 403 (GitHub Search API rate limit)
      if (error instanceof Error && error.message.includes('403')) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const response = await this.request<{
          total_count: number;
          items: Array<{
            number: number;
            state: 'open' | 'closed';
            title: string;
            body: string | null;
            labels: Array<{ name: string }>;
          }>;
        }>('GET', path);
        return response.items || [];
      }
      throw error;
    }
  }
}
