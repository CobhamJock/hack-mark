// Generic Container App module, reused for the api and the frontend.
// Pulls images with a user-assigned managed identity (no registry secrets).

@description('Azure region for the app.')
param location string

@description('Name of the container app.')
param appName string

@description('Resource ID of the Container Apps managed environment.')
param environmentId string

@description('Fully-qualified image reference, e.g. myregistry.azurecr.io/api:<tag>.')
param image string

@description('The port the container listens on (api=3000, frontend=80).')
param targetPort int

@description('Whether ingress is exposed externally (public).')
param externalIngress bool = true

@description('Login server of the ACR the image is pulled from.')
param registryLoginServer string

@description('Resource ID of the user-assigned managed identity that has AcrPull.')
param identityId string

@description('Environment variables for the container. Array of { name, value } objects.')
param env array = []

@description('Health probe path (GET).')
param probePath string = '/'

@description('Name of the environment storage link to mount (empty for none).')
param storageLinkName string = ''

@description('Mount path for the storage volume.')
param mountPath string = '/data'

@description('Tags applied to the app.')
param tags object = {}

@minValue(0)
param minReplicas int = 1

@minValue(1)
param maxReplicas int = 1

param cpu string = '0.5'
param memory string = '1.0Gi'

var hasVolume = !empty(storageLinkName)

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: externalIngress
        targetPort: targetPort
        transport: 'http'
        allowInsecure: false
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: env
          volumeMounts: hasVolume ? [
            {
              volumeName: 'data'
              mountPath: mountPath
            }
          ] : []
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: probePath
                port: targetPort
              }
              initialDelaySeconds: 15
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: probePath
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      volumes: hasVolume ? [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: storageLinkName
          // nobrl: SQLite byte-range locks are unreliable over SMB
          mountOptions: 'nobrl'
        }
      ] : []
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: maxReplicas > 1 ? [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ] : []
      }
    }
  }
}

@description('The fully-qualified domain name of the app.')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('The name of the container app.')
output appName string = containerApp.name
