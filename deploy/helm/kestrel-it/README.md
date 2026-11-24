# Kestrel-IT Helm chart

Install the chart with Helm 3 on a Kubernetes cluster that has an ingress controller and persistent storage, or configure your own database and storage. The chart deploys the web app, API, and PostgreSQL 16 by default.

## Install the beta

Create a values file with your actual hostname, ingress class, and TLS secret. Store secrets outside version control. Use a unique random database password, a JWT secret of at least 32 characters, and an encryption key of 64 hex characters. Generate separate values with `openssl rand -hex 32`.

```yaml
config:
  appUrl: https://inventory.example.com
  secrets:
    jwtSecret: "<generated JWT secret>"
    appEncryptionKey: "<generated encryption key>"
postgresql:
  auth:
    password: "<generated database password>"
ingress:
  className: nginx
  hosts:
    - host: inventory.example.com
  tls:
    - secretName: inventory-tls
      hosts:
        - inventory.example.com
```

```sh
helm upgrade --install kestrel-it oci://ghcr.io/marco-jj/charts/kestrel-it \
  --version 0.0.1-beta --namespace kestrel-it --create-namespace \
  --values kestrel-values.yaml --wait
```

Open the configured HTTPS origin to complete first-run setup. Keep the JWT signing key, application encryption key, and database credentials stable across upgrades. For an external database, disable `postgresql.enabled` and supply `config.secrets.externalDatabaseUrl` or set `config.existingSecret` to a Kubernetes Secret containing `DATABASE_URL`, `JWT_SECRET`, and `APP_ENCRYPTION_KEY`. The default local storage supports one API replica. Use shared storage or a ReadWriteMany claim for multiple replicas.

## Use from another Helm chart

Add the chart to the parent chart's `Chart.yaml` and configure its values under `kestrel-it`.

```yaml
dependencies:
  - name: kestrel-it
    version: 0.0.1-beta
    repository: oci://ghcr.io/marco-jj/charts
```

Run `helm dependency update` in the parent chart. The same package is available as a `.tgz` on the [GitHub release](https://github.com/marco-jj/kestrel-it/releases/tag/v0.0.1-beta).
