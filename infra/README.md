# Infrastructure (Azure Container Apps)

Bicep for the OctoCAT Supply app, deployed by `.github/workflows/deploy.yml`.

## Private storage networking migration

The lab's enforced Azure Policy disables public network access on storage accounts.
The original API cannot mount Azure Files and exits with `VolumeMountFailure` /
`mount error(13): Permission denied` before Node starts. Frontend product requests
then wait on an unavailable API; this is not a product-query or CORS failure.

The workflow now deploys `private-network.bicep`, an **additive migration** that:

- References the existing registry, storage account/share, managed identity and
  Log Analytics workspace without recreating them or relaxing storage policy.
- Adds `vnet-octocat-mark` (`10.33.0.0/16`), a dedicated delegated Container Apps
  subnet (`10.33.0.0/23`) and a private-endpoint subnet (`10.33.2.0/27`).
- Adds a storage `file` private endpoint, a `privatelink.file.core.windows.net`
  private DNS zone and its VNet link. Azure manages the private DNS records.
- Creates `octocat-mark-private-env` with a Consumption workload profile.
  The new environment needs VNet integration from creation; the original
  environment is retained rather than deleted.
- Creates `octocat-mark-private-api` and `octocat-mark-private-frontend`, retaining
  public HTTPS ingress for the browser while database traffic uses the VNet.
  **Their URLs differ from the original apps**; use the workflow outputs.

Private-endpoint, DNS and managed networking charges apply. The migration keeps
the existing SMB account-key mount (retrieved at deployment, never printed or
stored in source); it does not enable public access or shared-key REST access.
Managed-identity SMB authentication is a separate preview migration and is not
required for this network repair.

The shutdown script explicitly stops revisions of **both** old and replacement
API apps before deploying a replacement. Do not manually reactivate the old API
while the replacement is serving: both would access the same SQLite file.
Neither old apps nor their environment are deleted automatically. Clean them up
only after live verification and explicit approval.

The existing platform must already have been provisioned by `main.bicep`. Keep
that template for bootstrap/reference; do not redeploy its original public
environment as the fix for this policy-restricted lab.

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

Images must exist before the apps do, so `private-network.bicep` has a `deployApps` switch:

1. `deployApps=false` — private network, private endpoint/DNS and replacement environment.
2. Build and push images with `az acr build`, tagged with the commit SHA.
3. Stop both old and replacement API revisions and wait for zero replicas.
4. `deployApps=true imageTag=<sha> apiRevisionSuffix=<unique-run>` — replacement apps.
5. Smoke-test public HTTPS, requiring a non-empty product JSON array. Each
   request has a connection and total timeout; the deploy job is also bounded.

## Manual deploy

```sh
RG=rg-labuser-0033
az deployment group create -g $RG -n private-network -f infra/private-network.bicep -p infra/main.parameters.json deployApps=false
ACR=$(az deployment group show -g $RG -n private-network --query properties.outputs.acrName.value -o tsv)
az acr build -r $ACR -t api:dev -f src/api-ts/Dockerfile src
az acr build -r $ACR -t frontend:dev src/frontend
bash .github/scripts/stop-api-revisions.sh "$RG" octocat-mark-api octocat-mark-private-api
az deployment group create -g $RG -f infra/private-network.bicep -p infra/main.parameters.json deployApps=true imageTag=dev apiRevisionSuffix="manual-$(date +%s)"
```

For other prefixes/suffixes, use the `legacyApiAppName` and `apiAppName` outputs
instead of the example app names. Local checks (no deployment):

```sh
az bicep build --file infra/private-network.bicep
bash .github/scripts/stop-api-revisions.test.sh
az deployment group what-if -g rg-labuser-0033 -f infra/private-network.bicep -p infra/main.parameters.json deployApps=false
```

## GitHub Actions / OIDC

Create an Entra app registration with a federated credential for
`repo:<owner>/<repo>:environment:production`, grant it `Contributor` on the resource group
(plus `User Access Administrator`, needed for the AcrPull role assignment), and set these
repository variables (not secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`.
