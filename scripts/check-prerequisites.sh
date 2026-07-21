#!/usr/bin/env sh
set -eu
for command in az kubectl docker; do command -v "$command" >/dev/null || { echo "Required command '$command' was not found." >&2; exit 1; }; done
: "${AKS_OIDC_ISSUER_URL:?Set AKS_OIDC_ISSUER_URL for the existing AKS cluster.}"
echo "Argo existing-mode prerequisites are available."