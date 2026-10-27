// Storage account + Azure Files share that persists the API's SQLite database.

@description('Azure region for the storage account.')
param location string

@description('Globally-unique storage account name (3-24 lowercase alphanumerics).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Name of the file share mounted into the API container.')
param shareName string = 'octocat-data'

@description('Tags applied to the storage account.')
param tags object = {}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 5
  }
}

@description('Storage account name.')
output storageAccountName string = storage.name

@description('File share name.')
output shareName string = share.name
