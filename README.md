# Argo Workflows on Azure Container Apps Jobs

[![CI](https://github.com/hetvip2/argo-workflows-on-aca-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/hetvip2/argo-workflows-on-aca-jobs/actions/workflows/ci.yml)

Run workload containers as Azure Container Apps (ACA) Jobs while your existing Argo Workflows installation remains the control plane.

**Ownership boundary:** this existing-mode template does not deploy AKS, Argo Server, the workflow controller, artifact storage, or an Argo database. You operate those components. The template provisions a sample ACA Job and an Azure identity federated to one Kubernetes service account.

```mermaid
flowchart LR
  A[Existing Argo on AKS] -->|WorkflowTemplate| H[Helper pod]
  H -->|Workload Identity and ARM start| J[ACA Job]
  H -->|Poll saved execution name| ARM[ARM execution history]
  J --> ARM
```

Use this when Argo 3.5+ already runs on an AKS cluster with OIDC issuer and Azure Workload Identity enabled. Do not use it to host Argo or to run an interactive service as an ACA Job.

## Prerequisites

- Argo Workflows 3.5 or 3.6 on Kubernetes 1.29+
- Node.js 20.15+ for helper development; the image pins Node 22.17
- Docker, Azure CLI, Azure Developer CLI, and kubectl
- An AKS OIDC issuer URL and permission to create a federated identity and role assignment

## Quickstart

No Azure command below is run by CI. Review cost and scope before deployment.

PowerShell:

```powershell
$env:AKS_OIDC_ISSUER_URL = az aks show -g <aks-rg> -n <aks-name> --query oidcIssuerProfile.issuerUrl -o tsv
azd auth login
azd env new argo-aca-dev
azd env set AZURE_LOCATION eastus2
azd up
```

Linux/macOS:

```bash
export AKS_OIDC_ISSUER_URL="$(az aks show -g <aks-rg> -n <aks-name> --query oidcIssuerProfile.issuerUrl -o tsv)"
azd auth login
azd env new argo-aca-dev
azd env set AZURE_LOCATION eastus2
azd up
```

Build and push the helper to a registry your AKS cluster can pull, replace the four `REPLACE_*` values in `workflows/`, then apply them:

```bash
docker build -t <registry>/argo-aca-helper:0.1.0 .
docker push <registry>/argo-aca-helper:0.1.0
kubectl -n argo apply -f workflows/service-account.yaml -f workflows/workflow-template.yaml
argo -n argo submit --from workflowtemplate/aca-jobs --watch
argo -n argo submit --from workflowtemplate/aca-jobs --entrypoint fan-out-five --watch
```

## Offline and local validation

```bash
npm ci
npm run check
docker build -t argo-workflows-on-aca-jobs:test .
kubectl apply --dry-run=client --validate=false -f workflows/service-account.yaml -f workflows/workflow-template.yaml
az bicep build --file infra/main.bicep
```

A real local Argo path requires a Kubernetes cluster and Argo CLI/controller. Install the manifests into kind or Docker Desktop Kubernetes and replace ARM with a controlled HTTP stub to exercise the public `argo submit` path. This repository has not claimed that run until its evidence is recorded.

## Workloads, retries, and durability

Override `command-json`, `args-json`, `env-json`, `cpu`, `memory`, `job-name`, and timeout as Argo parameters. The helper retries only HTTP 429 and transient 5xx responses, honors `Retry-After`, refreshes once after 401, redacts response bodies, emits `argo-workflows-on-aca-jobs/0.1.0`, and propagates `{{workflow.uid}}-<shard>` as the ARM client request ID.

The start node outputs the stable ACA execution name into Argo node state. The wait node consumes that name, so wait retries resume without starting another execution. A failed/canceled ACA execution fails the Argo DAG and suppresses dependents. Deleting an Argo workflow does not cancel a running ACA execution; cancel it explicitly through ARM after confirming the execution identity.

The fan-out entry point creates five independent ACA executions. Tune Argo parallelism, ACA Job replica limits, ARM throttling, and poll interval together.

## Authentication and least privilege

`DefaultAzureCredential` uses the projected AKS workload identity token in production and Azure CLI locally. Never place access tokens in workflow parameters. The Bicep quickstart assigns the built-in Container Apps Jobs Operator role at the single sample Job scope. For tighter production access, replace it with a custom role containing only the job and execution actions your workflows use.

## Infrastructure and cleanup

The Bicep file uses stable `Microsoft.App` API `2024-03-01`, creates Log Analytics, an ACA environment, one manual Job, one user-assigned identity, federation, and job-scoped RBAC. The orchestrator and helper registry are intentionally external.

```bash
kubectl -n argo delete -f workflows/workflow-template.yaml -f workflows/service-account.yaml
azd down --purge
```

## Validation status

Offline adapter tests and compilation are required in CI. Live Azure execution, real Argo runtime, clean-clone, dedicated secret scan, and independent three-model review are not yet evidenced. Per the repository contract, status is **BLOCKED - LIVE VALIDATION REQUIRED** and publication is not recommended.

## Troubleshooting

- `401`: verify the service account label/annotation, pod label, federated issuer/subject/audience, and projected token.
- `403`: verify role assignment scope and propagation; do not log tokens to diagnose it.
- `404`: confirm subscription, resource group, job name, and API version.
- Timeout: inspect ACA execution history using the logged execution name; increasing Argo retries does not increase the execution timeout.
- Image pull failure: grant the AKS kubelet identity `AcrPull` or configure the existing cluster's approved registry credential path.

## Project structure and license

`src/` contains the reusable ARM helper, `workflows/` the native Argo resources, `infra/` azd Bicep, and `test/` offline behavior tests. Licensed under Apache-2.0.
