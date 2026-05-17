export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3004";

const TOKEN_KEY = "hydra_token";
const EMAIL_KEY = "hydra_email";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, email: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
}

export function getEmail(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(EMAIL_KEY);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(message, res.status);
  }

  // Some 202 responses may have an empty body; guard against that.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export type Session = {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  createdAt: string;
};

export type GraphNode = { id: string; name: string };
export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  sentiment: string | null;
  tValid: string | null;
  tCommit: string;
};
export type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

export type Candidate = {
  chunkId: string;
  score: number;
  rawText: string;
  enrichedText: string;
  entityRefs: string[];
  tCommit: string;
  retentionScore: number;
  tier: number;
  expansion: Array<{
    contextString: string;
    fromName: string;
    relation: string;
    toName: string;
    tCommit: string;
  }>;
};

export type GraphPath = {
  contextString: string;
  fromName: string;
  relation: string;
  toName: string;
  tCommit: string;
};

export type QueryResponse = {
  originalQuery: string;
  answer: string;
  reasoning: string;
  expansions: string[];
  queryEntities: string[];
  candidates: Candidate[];
  graphPaths: GraphPath[];
};

export { ApiError };
