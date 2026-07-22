import { writeFile } from "node:fs/promises";

import { DefaultAzureCredential } from "@azure/identity";

import { AcaJobsClient, type JobOverrides } from "./aca-jobs-client.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable ${name} is not set.`);
  return value;
};
const parseJson = <T>(name: string, fallback: T): T => {
  const value = process.env[name];
  return value ? (JSON.parse(value) as T) : fallback;
};

const localArmEndpoint = process.env.ACA_LOCAL_ARM_ENDPOINT;
const localArmToken = process.env.ACA_LOCAL_ARM_TOKEN;
if (
  (localArmEndpoint && !localArmToken) ||
  (!localArmEndpoint && localArmToken)
) {
  throw new Error(
    "ACA_LOCAL_ARM_ENDPOINT and ACA_LOCAL_ARM_TOKEN must be set together for isolated local smoke tests.",
  );
}
const credential = localArmToken ? undefined : new DefaultAzureCredential();

const client = new AcaJobsClient({
  target: {
    subscriptionId: required("AZURE_SUBSCRIPTION_ID"),
    resourceGroup: required("ACA_RESOURCE_GROUP"),
    jobName: required("ACA_JOB_NAME"),
  },
  ...(localArmEndpoint ? { armEndpoint: localArmEndpoint } : {}),
  getToken: async () => {
    if (localArmToken) return localArmToken;
    const token = await credential?.getToken(
      "https://management.azure.com/.default",
    );
    if (!token)
      throw new Error(
        "DefaultAzureCredential did not return an ARM access token.",
      );
    return token.token;
  },
});

const action = process.argv[2];
const correlationId = required("CORRELATION_ID");
if (action === "start") {
  const environment = parseJson<NonNullable<JobOverrides["env"]>>(
    "ACA_ENV_JSON",
    [],
  );
  environment.push({ name: "CORRELATION_ID", value: correlationId });
  if (process.env.SHARD) {
    environment.push({ name: "SHARD", value: process.env.SHARD });
  }
  const overrides: JobOverrides = {
    containerName: process.env.ACA_CONTAINER_NAME ?? "worker",
    image: required("ACA_IMAGE"),
    command: parseJson<string[]>("ACA_COMMAND_JSON", []),
    args: parseJson<string[]>("ACA_ARGS_JSON", []),
    env: environment,
    ...(process.env.ACA_CPU ? { cpu: Number(process.env.ACA_CPU) } : {}),
    ...(process.env.ACA_MEMORY ? { memory: process.env.ACA_MEMORY } : {}),
  };
  const executionName = await client.start(correlationId, overrides);
  const outputPath = process.env.EXECUTION_NAME_PATH ?? "/tmp/execution-name";
  await writeFile(outputPath, executionName, "utf8");
  console.log(
    JSON.stringify({ correlationId, executionName, phase: "started" }),
  );
} else if (action === "wait") {
  const executionName = required("ACA_EXECUTION_NAME");
  const result = await client.wait({
    executionName,
    correlationId,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
    timeoutMs: Number(process.env.EXECUTION_TIMEOUT_MS ?? 1800000),
  });
  console.log(JSON.stringify(result));
} else {
  throw new Error("Usage: node cli.js <start|wait>");
}
