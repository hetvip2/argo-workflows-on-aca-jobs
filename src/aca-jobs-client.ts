export const API_VERSION = "2024-03-01";
export const USER_AGENT = "argo-workflows-on-aca-jobs/0.1.0";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const ACTIVE = new Set(["Running", "Processing", "Pending"]);
const FAILED = new Set(["Failed", "Canceled", "Cancelled"]);

export interface JobTarget {
  subscriptionId: string;
  resourceGroup: string;
  jobName: string;
}

export interface JobOverrides {
  containerName?: string;
  image?: string;
  command?: string[];
  args?: string[];
  env?: Array<{ name: string; value?: string; secretRef?: string }>;
  cpu?: number;
  memory?: string;
}

export interface ExecutionResult {
  executionName: string;
  status: "Succeeded";
  correlationId: string;
  startedAt: string;
  completedAt: string;
}

export interface ClientOptions {
  target: JobTarget;
  getToken: () => Promise<string>;
  armEndpoint?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

export class AcaJobsError extends Error {}

export class AcaJobsClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.maxRetries = options.maxRetries ?? 5;
  }

  async start(
    correlationId: string,
    overrides?: JobOverrides,
  ): Promise<string> {
    const container = overrides
      ? {
          name: overrides.containerName ?? "worker",
          image: overrides.image,
          command: overrides.command,
          args: overrides.args,
          env: overrides.env,
          resources:
            overrides.cpu === undefined && overrides.memory === undefined
              ? undefined
              : { cpu: overrides.cpu, memory: overrides.memory },
        }
      : undefined;
    const response = await this.request(
      "POST",
      "start",
      container ? { containers: [container] } : undefined,
      correlationId,
    );
    const payload = await parseObjectOrEmpty(response);
    const bodyName =
      typeof payload.name === "string" ? payload.name : undefined;
    const locationName = response.headers
      .get("location")
      ?.match(/\/executions\/([^/?]+)/)?.[1];
    const executionName = bodyName ?? locationName;
    if (!executionName) {
      throw new AcaJobsError(
        "ACA start response did not include an execution name in its body or Location header.",
      );
    }
    return executionName;
  }

  async wait(input: {
    executionName: string;
    correlationId: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<ExecutionResult> {
    const startedAt = new Date(this.now()).toISOString();
    const deadline = this.now() + (input.timeoutMs ?? 30 * 60_000);
    while (this.now() < deadline) {
      const response = await this.request(
        "GET",
        `executions/${encodeURIComponent(input.executionName)}`,
        undefined,
        input.correlationId,
      );
      const payload = await parseObjectOrEmpty(response);
      const properties = isObject(payload.properties) ? payload.properties : {};
      const status = properties.status;
      if (status === "Succeeded") {
        return {
          executionName: input.executionName,
          status,
          correlationId: input.correlationId,
          startedAt,
          completedAt: new Date(this.now()).toISOString(),
        };
      }
      if (typeof status !== "string" || !status) {
        throw new AcaJobsError(
          "ACA execution response did not include properties.status.",
        );
      }
      if (FAILED.has(status)) {
        throw new AcaJobsError(
          `ACA Job execution '${input.executionName}' finished with status '${status}'.`,
        );
      }
      if (!ACTIVE.has(status)) {
        throw new AcaJobsError(
          `ACA Job execution '${input.executionName}' returned unknown status '${status}'.`,
        );
      }
      await this.sleep(input.pollIntervalMs ?? 5_000);
    }
    throw new AcaJobsError(
      `Timed out waiting for ACA Job execution '${input.executionName}'.`,
    );
  }

  async startAndWait(input: {
    correlationId: string;
    overrides?: JobOverrides;
    executionName?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<ExecutionResult> {
    const executionName =
      input.executionName ??
      (await this.start(input.correlationId, input.overrides));
    return this.wait({
      executionName,
      correlationId: input.correlationId,
      ...(input.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }

  private async request(
    method: string,
    path: string,
    body: object | undefined,
    correlationId: string,
  ): Promise<Response> {
    let token = await this.options.getToken();
    let refreshed = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const request: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "x-ms-client-request-id": correlationId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      const response = await this.fetchImpl(
        `${this.baseUrl}/${path}?api-version=${API_VERSION}`,
        request,
      );
      if (response.status === 401 && !refreshed) {
        token = await this.options.getToken();
        refreshed = true;
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1_000
          : Math.min(1_000 * 2 ** attempt, 30_000);
        await this.sleep(delay);
        continue;
      }
      if (!response.ok) {
        throw new AcaJobsError(
          `ARM request failed with HTTP ${response.status}.`,
        );
      }
      return response;
    }
    throw new AcaJobsError("ARM request exhausted its retry budget.");
  }

  private get baseUrl(): string {
    const { subscriptionId, resourceGroup, jobName } = this.options.target;
    const armEndpoint =
      this.options.armEndpoint ?? "https://management.azure.com";
    return `${armEndpoint.replace(/\/$/, "")}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/jobs/${encodeURIComponent(jobName)}`;
  }
}

async function parseObjectOrEmpty(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) return value;
  } catch {
    // Convert parser details into a stable, secret-safe error below.
  }
  throw new AcaJobsError("ARM returned malformed JSON.");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
