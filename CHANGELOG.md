# Changelog

## v0.0.1-beta

First beta of Kestrel-IT.

- Core inventory includes assets, models, custom fields, users, groups, and company-scoped permissions.
- Asset operations include checkout and check-in, acceptance and signatures, audits, maintenance, and depreciation.
- Secondary inventory includes licenses, accessories, consumables, components, and kits.
- Operators can import CSV data, print labels, use saved reports, export CSV and Excel, and configure notifications.
- Authentication includes local accounts with TOTP, OIDC and OAuth, personal access tokens, and the Better Auth bridge.
- One Helm chart deploys the web app, API, and optional PostgreSQL. The release includes an OpenAPI contract with request-body schemas.

The Snipe-IT database migration CLI and independent visual parity verification are still pending. See the [upstream feature map](docs/08-upstream-feature-map.md).
