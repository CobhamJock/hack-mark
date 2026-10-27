// =============================================================================
// main.bicep — OctoCAT Supply on Azure Container Apps
//
//   ACR <──AcrPull (user-assigned identity)── api (:3000, external) ── Azure Files (/data, SQLite)
//                                             frontend (nginx :80, external) ── calls api from the browser
//   Both apps log to Log Analytics.
//
// The browser calls the API directly (see src/frontend/entrypoint.sh), so the
// api ingress must be external and the frontend gets the api's public FQDN.
// SQLite lives on an Azure Files share, so the api runs as a single replica.
//
// Deploy in two phases (see .github/workflows/deploy.yml):
//   1. deployApps=false  -> registry, storage, environment, identity
//   2. deployApps=true   -> the container apps (after images are pushed)
// =============================================================================

targetScope = 'resourceGroup'

@description('Azure region for all resources. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Short prefix used to derive resource names (lowercase letters/numbers).')
@minLength(2)
@maxLength(12)
param namePrefix string = 'octocat'

@description('Environment name / suffix (e.g. dev, mark). Keeps names unique.')
@minLength(2)
@maxLength(12)
param environmentName string = 'mark'

@description('Create the container apps. False for the first phase that only provisions the registry and platform.')
param deployApps bool = true

@description('Image tag to deploy for both apps (e.g. the commit SHA).')
param imageTag string = 'latest'

@description('Unique suffix for the API revision (e.g. run id + attempt) so every deployment creates a new revision.')
param apiRevisionSuffix string = ''

var baseName = '${namePrefix}-${environmentName}'
var compactName = toLower(replace('${namePrefix}${environmentName}', '-', ''))
var uniq = take(uniqueString(resourceGroup().id), 5)
var registryName = take('${compactName}${uniq}acr', 50)
var storageAccountName = take('${compactName}${uniq}st', 24)
var logAnalyticsName = '${baseName}-logs'
var environmentResourceName = '${baseName}-env'
var identityName = '${baseName}-id'
var apiAppName = '${baseName}-api'
var frontendAppName = '${baseName}-frontend'

var commonTags = {
  project: 'octocat-supply'
  challenge: 'challenge-5-azure-deploy'
  managedBy: 'bicep'
  environment: environmentName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: commonTags
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    registryName: registryName
    pullPrincipalId: pullIdentity.properties.principalId
    tags: commonTags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    storageAccountName: storageAccountName
    tags: commonTags
  }
}

module logAnalytics 'modules/loganalytics.bicep' = {
  name: 'loganalytics'
  params: {
    location: location
    workspaceName: logAnalyticsName
    tags: commonTags
  }
}

module environment 'modules/containerapp-env.bicep' = {
  name: 'containerapp-env'
  params: {
    location: location
    environmentName: environmentResourceName
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    storageAccountName: storage.outputs.storageAccountName
    shareName: storage.outputs.shareName
    tags: commonTags
  }
}

// FQDNs are derived from the environment's default domain so the two apps can
// reference each other without a circular dependency.
var apiFqdn = '${apiAppName}.${environment.outputs.defaultDomain}'
var frontendFqdn = '${frontendAppName}.${environment.outputs.defaultDomain}'

module apiApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'api-app'
  params: {
    location: location
    appName: apiAppName
    environmentId: environment.outputs.environmentId
    image: '${registry.outputs.loginServer}/api:${imageTag}'
    targetPort: 3000
    externalIngress: true
    registryLoginServer: registry.outputs.loginServer
    identityId: pullIdentity.id
    storageLinkName: environment.outputs.storageLinkName
    // Multiple: the pipeline deactivates old revisions before each deploy so only one
    // process ever opens the SQLite file
    revisionMode: 'Multiple'
    revisionSuffix: apiRevisionSuffix
    // SQLite on one replica only: concurrent writers over SMB would corrupt it
    minReplicas: 1
    maxReplicas: 1
    tags: commonTags
    env: [
      { name: 'PORT', value: '3000' }
      { name: 'DB_FILE', value: '/data/app.db' }
      // WAL relies on shared memory, which SMB shares don't support
      { name: 'DB_ENABLE_WAL', value: 'false' }
      { name: 'API_CORS_ORIGINS', value: 'https://${frontendFqdn}' }
    ]
  }
}

module frontendApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'frontend-app'
  params: {
    location: location
    appName: frontendAppName
    environmentId: environment.outputs.environmentId
    image: '${registry.outputs.loginServer}/frontend:${imageTag}'
    targetPort: 80
    externalIngress: true
    registryLoginServer: registry.outputs.loginServer
    identityId: pullIdentity.id
    minReplicas: 1
    maxReplicas: 2
    tags: commonTags
    env: [
      { name: 'API_HOST', value: apiFqdn }
      { name: 'API_PORT', value: '443' }
      { name: 'API_PROTOCOL', value: 'https' }
    ]
  }
}

@description('ACR name — used by the workflow for az acr build.')
output acrName string = registry.outputs.registryName

@description('ACR login server.')
output acrLoginServer string = registry.outputs.loginServer

@description('Public URL of the frontend app.')
output frontendUrl string = 'https://${frontendFqdn}'

@description('Public URL of the api app.')
output apiUrl string = 'https://${apiFqdn}'

@description('Container app names, for az containerapp commands.')
output apiAppName string = apiAppName
output frontendAppName string = frontendAppName
