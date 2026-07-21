param(
    [string]$ClusterName = 'argoaca',
    [string]$ArgoVersion = 'v3.7.16',
    [string]$ArgoChartVersion = '0.47.1',
    [switch]$KeepCluster
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
$kind = (Get-Command kind -ErrorAction SilentlyContinue).Source
$helm = (Get-Command helm -ErrorAction SilentlyContinue).Source
if (-not $kind) { $kind = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Kubernetes.kind_*\kind.exe" -ErrorAction Stop | Select-Object -First 1 -ExpandProperty FullName }
if (-not $helm) { $helm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Helm.Helm_*\*\helm.exe" -ErrorAction Stop | Select-Object -First 1 -ExpandProperty FullName }
$argo = Join-Path $env:TEMP "argo-$($ArgoVersion.TrimStart('v')).exe"

function Assert-Phase([string]$name, [string]$phase) {
    $actual = kubectl -n argo get workflow $name -o jsonpath='{.status.phase}'
    if ($actual -ne $phase) { throw "Workflow '$name' phase '$actual', expected '$phase'." }
}

try {
    & $kind create cluster --name $ClusterName --wait 120s
    docker build -t argo-aca-helper:local $root
    docker build -t argo-aca-arm-stub:local -f (Join-Path $root 'test/local/Dockerfile.arm-stub') (Join-Path $root 'test/local')
    & $kind load docker-image --name $ClusterName argo-aca-helper:local argo-aca-arm-stub:local
    & $helm repo add argo https://argoproj.github.io/argo-helm --force-update
    & $helm repo update
    & $helm upgrade --install argo-workflows argo/argo-workflows --version $ArgoChartVersion --namespace argo --create-namespace --set images.tag=$ArgoVersion --set server.enabled=false
    kubectl -n argo rollout status deployment/argo-workflows-workflow-controller --timeout=180s
    kubectl -n argo apply -f (Join-Path $root 'test/local/arm-stub.yaml')
    kubectl -n argo rollout status deployment/arm-stub --timeout=120s
    kubectl -n argo apply -f (Join-Path $root 'workflows/service-account.yaml') -f (Join-Path $root 'workflows/workflow-template.yaml')
    kubectl -n argo patch workflowtemplate aca-jobs --type=json -p '[{"op":"add","path":"/spec/templates/4/container/env/-","value":{"name":"ACA_LOCAL_ARM_ENDPOINT","value":"http://arm-stub:8080"}},{"op":"add","path":"/spec/templates/4/container/env/-","value":{"name":"ACA_LOCAL_ARM_TOKEN","value":"local-smoke-only"}},{"op":"add","path":"/spec/templates/5/container/env/-","value":{"name":"ACA_LOCAL_ARM_ENDPOINT","value":"http://arm-stub:8080"}},{"op":"add","path":"/spec/templates/5/container/env/-","value":{"name":"ACA_LOCAL_ARM_TOKEN","value":"local-smoke-only"}}]'
    if (-not (Test-Path $argo)) {
        $archive = "$argo.gz"
        Invoke-WebRequest "https://github.com/argoproj/argo-workflows/releases/download/$ArgoVersion/argo-windows-amd64.exe.gz" -OutFile $archive
        $input = [IO.File]::OpenRead($archive); $gzip = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress); $output = [IO.File]::Create($argo)
        try { $gzip.CopyTo($output) } finally { $output.Dispose(); $gzip.Dispose(); $input.Dispose(); Remove-Item $archive }
    }
    $single = & $argo -n argo submit --from workflowtemplate/aca-jobs --name smoke-single -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=success --wait -o name
    Assert-Phase 'smoke-single' 'Succeeded'
    $fanout = & $argo -n argo submit --from workflowtemplate/aca-jobs --entrypoint fan-out-five --name smoke-fanout -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=success --wait -o name
    Assert-Phase 'smoke-fanout' 'Succeeded'
    $failed = & $argo -n argo submit --from workflowtemplate/aca-jobs --entrypoint failure-with-suppressed-downstream --name smoke-failure -p helper-image=argo-aca-helper:local -p subscription-id=local -p resource-group=local -p job-name=terminal-failure --wait -o name 2>&1
    Assert-Phase 'smoke-failure' 'Failed'
    $fanoutNodes = kubectl -n argo get workflow smoke-fanout -o json | ConvertFrom-Json
    $shards = @($fanoutNodes.status.nodes.psobject.Properties.Value | Where-Object { $_.displayName -match '^shard\([0-4](?::[0-4])?\)$' -and $_.type -eq 'DAG' -and $_.phase -eq 'Succeeded' })
    $fanIn = @($fanoutNodes.status.nodes.psobject.Properties.Value | Where-Object { $_.displayName -eq 'fan-in' -and $_.phase -eq 'Succeeded' })
    $failureNodes = kubectl -n argo get workflow smoke-failure -o json | ConvertFrom-Json
    $downstream = @($failureNodes.status.nodes.psobject.Properties.Value | Where-Object { $_.displayName -eq 'must-not-run' -and $_.phase -notin @('Omitted','Skipped') })
    $starts = @(kubectl -n argo logs deployment/arm-stub | Select-String '"event":"start"')
    if ($shards.Count -ne 5) { throw "Expected exactly five shard DAG nodes; found $($shards.Count)." }
    if ($fanIn.Count -ne 1) { throw "Expected one successful fan-in node; found $($fanIn.Count)." }
    if ($downstream.Count -ne 0) { throw 'Failure downstream task executed unexpectedly.' }
    if ($starts.Count -ne 7) { throw "Expected seven execution starts (1+5+1); found $($starts.Count)." }
    $identities = $starts | ForEach-Object { ($_ -replace '^.*?(\{)', '$1') | ConvertFrom-Json }
    if (@($identities.executionName | Sort-Object -Unique).Count -ne 7) { throw 'Execution identities were not unique.' }
    Write-Host "PASS single=Succeeded fanoutShards=5 fanIn=Succeeded failure=Failed downstream=Suppressed uniqueExecutions=7"
    Write-Host "IDENTITIES $($identities.executionName -join ',')"
} finally {
    if (-not $KeepCluster) { & $kind delete cluster --name $ClusterName }
}