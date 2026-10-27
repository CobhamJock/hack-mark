// Additive migration of the existing platform to private Azure Files connectivity.
// The original environment/apps remain intact; replacement apps receive new URLs.
targetScope = 'resourceGroup'

@description('Region for the replacement environment and network.')
param location string = resourceGroup().location

@description('Prefix of the existing OctoCAT platform.')
@minLength(2)
@maxLength(12)
param namePrefix string = 'octocat'

@description('Suffix of the existing OctoCAT platform.')
@minLength(2)
@maxLength(12)
param environmentName string = 'mark'

@description('Deploy apps after building images and stopping old API revisions.')
param deployApps bool = false

@description('Image tag to deploy for both replacement apps.')
param imageTag string = 'latest'

@description('Unique API revision suffix, including workflow run ID and attempt.')
param apiRevisionSuffix string = ''

var baseName = '${namePrefix}-${environmentName}'
var compactName = toLower(replace('${namePrefix}${environmentName}', '-', ''))
var uniq = take(uniqueString(resourceGroup().id), 5)
var apiName = '${baseName}-private-api'
var frontendName = '${baseName}-private-frontend'
var tags = {
  project: 'octocat-supply'
  challenge: 'challenge-5-azure-deploy'
  managedBy: 'bicep'
  environment: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: take('${compactName}${uniq}acr', 50)
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: take('${compactName}${uniq}st', 24)
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: '${baseName}-logs'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseName}-id'
}

module network 'modules/private-network.bicep' = {
  name: 'private-network'
  params: {
    location: location
    baseName: baseName
    storageAccountId: storage.id
    tags: tags
  }
}

module environment 'modules/containerapp-env.bicep' = {
  name: 'private-containerapp-env'
  params: {
    location: location
    environmentName: '${baseName}-private-env'
    logAnalyticsWorkspaceId: logs.id
    storageAccountName: storage.name
    shareName: 'octocat-data'
    infrastructureSubnetId: network.outputs.infrastructureSubnetId
    tags: tags
  }
}

var apiHost = '${apiName}.${environment.outputs.defaultDomain}'
var frontendHost = '${frontendName}.${environment.outputs.defaultDomain}'

module api 'modules/containerapp.bicep' = if (deployApps) {
  name: 'private-api'
  params: {
    location: location
    appName: apiName
    environmentId: environment.outputs.environmentId
    image: '${registry.properties.loginServer}/api:${imageTag}'
    targetPort: 3000
    registryLoginServer: registry.properties.loginServer
    identityId: identity.id
    storageLinkName: environment.outputs.storageLinkName
    revisionMode: 'Multiple'
    revisionSuffix: apiRevisionSuffix
    minReplicas: 1
    maxReplicas: 1
    tags: tags
    env: [
      { name: 'PORT', value: '3000' }
      { name: 'DB_FILE', value: '/data/app.db' }
      { name: 'DB_ENABLE_WAL', value: 'false' }
      { name: 'API_CORS_ORIGINS', value: 'https://${frontendHost}' }
    ]
  }
}

module frontend 'modules/containerapp.bicep' = if (deployApps) {
  name: 'private-frontend'
  params: {
    location: location
    appName: frontendName
    environmentId: environment.outputs.environmentId
    image: '${registry.properties.loginServer}/frontend:${imageTag}'
    targetPort: 80
    registryLoginServer: registry.properties.loginServer
    identityId: identity.id
    minReplicas: 1
    maxReplicas: 2
    tags: tags
    env: [
      { name: 'API_HOST', value: apiHost }
      { name: 'API_PORT', value: '443' }
      { name: 'API_PROTOCOL', value: 'https' }
    ]
  }
}

output acrName string = registry.name
output apiAppName string = apiName
output legacyApiAppName string = '${baseName}-api'
output frontendUrl string = 'https://${frontendHost}'
output apiUrl string = 'https://${apiHost}'
