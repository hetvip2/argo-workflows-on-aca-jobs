$ErrorActionPreference = 'Stop'
foreach ($command in @('az', 'kubectl', 'docker')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." }
}
if (-not $env:AKS_OIDC_ISSUER_URL) { throw 'Set AKS_OIDC_ISSUER_URL for the existing AKS cluster.' }
Write-Host 'Argo existing-mode prerequisites are available.'