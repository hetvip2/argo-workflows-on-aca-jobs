#!/usr/bin/env sh
set -eu
CLUSTER_NAME="${CLUSTER_NAME:-argoaca}"
ARGO_VERSION="${ARGO_VERSION:-v3.7.16}"
ARGO_CHART_VERSION="${ARGO_CHART_VERSION:-0.47.1}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cleanup() { [ "${KEEP_CLUSTER:-0}" = 1 ] || kind delete cluster --name "$CLUSTER_NAME"; }
trap cleanup EXIT
for command in kind helm kubectl docker curl gzip; do command -v "$command" >/dev/null || { echo "Required command '$command' was not found." >&2; exit 1; }; done
kind create cluster --name "$CLUSTER_NAME" --wait 120s
docker build -t argo-aca-helper:local "$ROOT"
docker build -t argo-aca-arm-stub:local -f "$ROOT/test/local/Dockerfile.arm-stub" "$ROOT/test/local"
kind load docker-image --name "$CLUSTER_NAME" argo-aca-helper:local argo-aca-arm-stub:local
helm repo add argo https://argoproj.github.io/argo-helm --force-update
helm repo update
helm upgrade --install argo-workflows argo/argo-workflows --version "$ARGO_CHART_VERSION" --namespace argo --create-namespace --set images.tag="$ARGO_VERSION" --set server.enabled=false
kubectl -n argo rollout status deployment/argo-workflows-workflow-controller --timeout=180s
kubectl -n argo apply -f "$ROOT/test/local/arm-stub.yaml"
kubectl -n argo rollout status deployment/arm-stub --timeout=120s
kubectl -n argo apply -f "$ROOT/workflows/service-account.yaml" -f "$ROOT/workflows/workflow-template.yaml"
kubectl -n argo patch workflowtemplate aca-jobs --type=json -p='[{"op":"add","path":"/spec/templates/4/container/env/-","value":{"name":"ACA_LOCAL_ARM_ENDPOINT","value":"http://arm-stub:8080"}},{"op":"add","path":"/spec/templates/4/container/env/-","value":{"name":"ACA_LOCAL_ARM_TOKEN","value":"local-smoke-only"}},{"op":"add","path":"/spec/templates/5/container/env/-","value":{"name":"ACA_LOCAL_ARM_ENDPOINT","value":"http://arm-stub:8080"}},{"op":"add","path":"/spec/templates/5/container/env/-","value":{"name":"ACA_LOCAL_ARM_TOKEN","value":"local-smoke-only"}}]'
ARGO_BIN="${TMPDIR:-/tmp}/argo-${ARGO_VERSION}"
[ -x "$ARGO_BIN" ] || { curl -fsSL "https://github.com/argoproj/argo-workflows/releases/download/$ARGO_VERSION/argo-linux-amd64.gz" | gzip -d > "$ARGO_BIN"; chmod +x "$ARGO_BIN"; }
"$ARGO_BIN" -n argo submit --from workflowtemplate/aca-jobs --name smoke-single -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=success --wait
"$ARGO_BIN" -n argo submit --from workflowtemplate/aca-jobs --entrypoint fan-out-five --name smoke-fanout -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=success --wait
if "$ARGO_BIN" -n argo submit --from workflowtemplate/aca-jobs --entrypoint failure-with-suppressed-downstream --name smoke-failure -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=terminal-failure --wait; then echo 'Failure workflow unexpectedly succeeded.' >&2; exit 1; fi
[ "$(kubectl -n argo get workflow smoke-single -o jsonpath='{.status.phase}')" = Succeeded ]
[ "$(kubectl -n argo get workflow smoke-fanout -o jsonpath='{.status.phase}')" = Succeeded ]
[ "$(kubectl -n argo get workflow smoke-failure -o jsonpath='{.status.phase}')" = Failed ]
[ "$(kubectl -n argo get workflow smoke-fanout -o jsonpath='{range .status.nodes[*]}{.displayName}{"\t"}{.type}{"\n"}{end}' | grep -Ec '^shard\([0-4]\)[[:space:]]+DAG$')" -eq 5 ]
[ "$(kubectl -n argo get workflow smoke-fanout -o jsonpath='{range .status.nodes[*]}{.displayName}{"\t"}{.phase}{"\n"}{end}' | grep -Ec '^fan-in[[:space:]]+Succeeded$')" -eq 1 ]
! kubectl -n argo get workflow smoke-failure -o jsonpath='{range .status.nodes[*]}{.displayName}{"\t"}{.phase}{"\n"}{end}' | grep -E '^must-not-run[[:space:]]+(Succeeded|Running|Failed)$'
STARTS=$(kubectl -n argo logs deployment/arm-stub | grep -c '"event":"start"')
[ "$STARTS" -eq 7 ]
echo 'PASS single=Succeeded fanoutShards=5 fanIn=Succeeded failure=Failed downstream=Suppressed uniqueExecutions=7'
kubectl -n argo logs deployment/arm-stub | grep '"event":"start"'