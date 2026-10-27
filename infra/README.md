# Infrastructure (Azure Container Apps)

Bicep for the OctoCAT Supply app, deployed by `.github/workflows/deploy.yml`.

## Architecture

| Resource | Module | Notes |
| --- | --- | --- |
| Container Registry | `modules/registry.bicep` | Basic SKU, admin user disabled; a user-assigned identity holds `AcrPull`. |
| Storage + Azure Files share | `modules/storage.bicep` | Persists the API's SQLite database. |
| Log Analytics | `modules/loganalytics.bicep` | Receives container logs. |
| Container Apps environment | `modules/containerapp-env.bicep` | Links the file share as environment storage. |
| `api` and `frontend` apps | `modules/containerapp.bicep` | Identity-based ACR pulls, liveness/readiness probes. |

Design decisions:

- **API ingress is external.** The browser calls the API directly
  (`src/frontend/entrypoint.sh` writes `API_URL` into `runtime-config.js`; nginx does not proxy `/api`).
  The frontend gets `API_HOST=<api fqdn>`, `API_PORT=443`, `API_PROTOCOL=https`, and the API's CORS
  allows only the frontend URL.
- **SQLite on Azure Files**, mounted at `/data` (`DB_FILE=/data/app.db`) with `nobrl` mount option and
  `DB_ENABLE_WAL=false` (WAL needs shared memory, which SMB lacks). The API is pinned to **one replica**
  because concurrent SQLite writers over SMB are unsafe. Migrations and seeding run on start and are idempotent.
- **No secrets in source.** Registry pulls use managed identity; GitHub deploys with OIDC.

Because a new revision starts before the old one is retired in single-revision mode, the API runs in
multiple-revision mode and the workflow deactivates all existing API revisions, then waits for their
replicas to stop, before each deployment. Two revisions therefore never open the database together
(this causes a short API outage on every deploy).

## Two-phase deployment

Images must exist before the apps do, so `main.bicep` has a `deployApps` switch:

1. `deployApps=false` — registry, storage, environment, identity.
2. Build and push images with `az acr build`, tagged with the commit SHA.
3. `deployApps=true imageTag=<sha>` — the container apps.

## Manual deploy

```sh
RG=rg-labuser-0033
az deployment group create -g $RG -f infra/main.bicep -p infra/main.parameters.json deployApps=false
ACR=$(az deployment group show -g $RG -n main --query properties.outputs.acrName.value -o tsv)
az acr build -r $ACR -t api:dev -f api-ts/Dockerfile src
az acr build -r $ACR -t frontend:dev src/frontend
az deployment group create -g $RG -f infra/main.bicep -p infra/main.parameters.json deployApps=true imageTag=dev
```

## GitHub Actions / OIDC

Create an Entra app registration with a federated credential for
`repo:<owner>/<repo>:environment:production`, grant it `Contributor` on the resource group
(plus `User Access Administrator`, needed for the AcrPull role assignment), and set these
repository variables (not secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`.
