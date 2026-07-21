import { describe, expect, it, vi } from "vitest";

import {
  AcaJobsClient,
  AcaJobsError,
  USER_AGENT,
} from "../src/aca-jobs-client.js";

const target = { subscriptionId: "sub", resourceGroup: "rg", jobName: "job" };

function response(
  status: number,
  body?: object,
  headers?: Record<string, string>,
): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

describe("AcaJobsClient", () => {
  it("starts once, sends overrides and correlation, then polls to success", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { name: "job-abc" }))
      .mockResolvedValueOnce(
        response(200, { properties: { status: "Running" } }),
      )
      .mockResolvedValueOnce(
        response(200, { properties: { status: "Succeeded" } }),
      );
    const client = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch,
      sleep: async () => {},
    });

    const result = await client.startAndWait({
      correlationId: "argo-run-1",
      overrides: {
        command: ["echo"],
        args: ["hello"],
        env: [{ name: "SHARD", value: "1" }],
        cpu: 0.5,
        memory: "1Gi",
      },
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      executionName: "job-abc",
      status: "Succeeded",
      correlationId: "argo-run-1",
    });
    const firstCall = fetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    const request = firstCall?.[1];
    expect(request?.headers).toMatchObject({
      "User-Agent": USER_AGENT,
      "x-ms-client-request-id": "argo-run-1",
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      containers: [
        {
          name: "worker",
          command: ["echo"],
          args: ["hello"],
          env: [{ name: "SHARD", value: "1" }],
          resources: { cpu: 0.5, memory: "1Gi" },
        },
      ],
    });
  });

  it("resumes a known execution without starting a duplicate", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response(200, { properties: { status: "Succeeded" } }),
      );
    const client = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch,
    });

    await client.startAndWait({
      correlationId: "argo-run-2",
      executionName: "existing",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/executions/existing");
  });

  it("uses an explicitly injected ARM endpoint for isolated local smoke tests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(200, { name: "local-execution" }));
    const client = new AcaJobsClient({
      target,
      getToken: async () => "local-token",
      armEndpoint: "http://arm-stub.local/",
      fetch,
    });

    await client.start("local-run");

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://arm-stub.local/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/jobs/job/start?api-version=2024-03-01",
    );
  });

  it("honors Retry-After and refreshes once after 401", async () => {
    const sleep = vi.fn(async () => {});
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("old")
      .mockResolvedValueOnce("new");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(429, undefined, { "Retry-After": "2" }))
      .mockResolvedValueOnce(
        response(200, undefined, { Location: "/executions/retried" }),
      );
    const client = new AcaJobsClient({ target, getToken, fetch, sleep });

    await expect(client.start("argo-run-3")).resolves.toBe("retried");
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it.each([400, 403, 404])(
    "does not retry permanent HTTP %s or leak response data",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(status, { secret: "do-not-log" }));
      const client = new AcaJobsClient({
        target,
        getToken: async () => "token-secret",
        fetch,
        sleep: async () => {},
      });

      await expect(client.start("argo-run-4")).rejects.toThrow(
        `ARM request failed with HTTP ${status}.`,
      );
      await expect(client.start("argo-run-4")).rejects.not.toThrow(
        /do-not-log|token-secret/,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("maps terminal failure, unknown state, malformed JSON, and timeout to explicit errors", async () => {
    const failed = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(200, { properties: { status: "Failed" } })),
    });
    await expect(
      failed.wait({ executionName: "failed", correlationId: "run" }),
    ).rejects.toThrow(AcaJobsError);

    const unknown = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(200, { properties: { status: "Mystery" } }),
        ),
    });
    await expect(
      unknown.wait({ executionName: "odd", correlationId: "run" }),
    ).rejects.toThrow("unknown status 'Mystery'");

    const malformed = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("{bad", { status: 200 })),
    });
    await expect(malformed.start("run")).rejects.toThrow(
      "ARM returned malformed JSON.",
    );

    let now = 0;
    const timeout = new AcaJobsClient({
      target,
      getToken: async () => "token",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(200, { properties: { status: "Running" } }),
        ),
      now: () => now,
      sleep: async () => {
        now += 2;
      },
    });
    await expect(
      timeout.wait({
        executionName: "slow",
        correlationId: "run",
        timeoutMs: 1,
      }),
    ).rejects.toThrow("Timed out");
  });
});
