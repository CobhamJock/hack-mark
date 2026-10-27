// =============================================================================
// Module: registry.bicep  (Azure Container Registry)
// -----------------------------------------------------------------------------
// Holds the two application images (api, frontend) that the Container Apps pull.
//
// This is a STARTER SKELETON. The core resource + key params are wired so the
// template compiles, but the meaningful decisions are left as // TODO for you.
// =============================================================================

@description('Azure region for the registry.')
param location string

@description('Globally-unique name for the container registry (alphanumeric, 5-50 chars).')
param registryName string

@description('Tags applied to the registry.')
param tags object = {}

// TODO: Decide the SKU. Basic is cheapest and fine for a hackathon; Standard/
//       Premium add throughput, geo-replication, private endpoints, etc.
//       Ask Copilot for Well-Architected guidance if unsure.
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

@description('Admin user is disabled; apps pull with a managed identity holding AcrPull.')
param adminUserEnabled bool = false

@description('Principal ID of the managed identity that is granted AcrPull.')
param pullPrincipalId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: adminUserEnabled
    // TODO: Consider `publicNetworkAccess: 'Disabled'` + private endpoints for
    //       a hardened setup, and `anonymousPullEnabled: false`.
  }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

@description('The login server host name of the registry (e.g. myregistry.azurecr.io).')
output loginServer string = registry.properties.loginServer

@description('The resource ID of the registry (useful for role assignments).')
output registryId string = registry.id

@description('The name of the registry.')
output registryName string = registry.name
