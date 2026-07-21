targetScope = 'resourceGroup'

@minLength(1)
param location string = resourceGroup().location
param environmentName string
param jobName string
param identityName string
param aksOidcIssuerUrl string
param workloadIdentitySubject string = 'system:serviceaccount:argo:aca-jobs-runner'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${environmentName}-logs'
  location: location
  properties: { retentionInDays: 30 }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  properties: {
    environmentId: environment.id
    configuration: { triggerType: 'Manual', replicaTimeout: 1800, replicaRetryLimit: 0 }
    template: {
      containers: [
        {
          name: 'worker'
          image: 'mcr.microsoft.com/azurelinux/base/core:3.0'
          command: ['/bin/sh', '-c']
          args: ['echo default ACA Jobs workload']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'argo-aks'
  properties: {
    audiences: ['api://AzureADTokenExchange']
    issuer: aksOidcIssuerUrl
    subject: workloadIdentitySubject
  }
}

resource operator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, identity.id, 'aca-job-operator')
  scope: job
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b')
  }
}

output jobName string = job.name
output identityClientId string = identity.properties.clientId
output jobResourceId string = job.id