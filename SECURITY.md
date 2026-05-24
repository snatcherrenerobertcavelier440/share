# Security policy

## Intended use

Share's default public-demo profile is for temporary, non-confidential transfers. A read link or manage link is a bearer capability: anyone who receives it can use its granted actions until expiry or deletion.

Do not use the public-demo profile for regulated, sensitive, or customer production data. Deploy an identity-backed variant with approved authentication, retention, scanning, audit, and incident-response policies for those workloads.

## Default controls

- Private R2 storage; all access is routed through the Worker.
- Separate unguessable read and manage capabilities, stored server-side only as hashes.
- Turnstile-gated creation.
- Default 64 MiB file limit, 1 GiB retained-byte ceiling, and five creations per client key per hour.
- One-hour incomplete upload expiry and 24-hour completed share expiry.
- Two-file-equivalent accepted upload-byte budget, allowing one full retry across parts.
- Four-file-equivalent download byte budget, reserved before R2 reads.
- Request-time expiry enforcement with alarm-driven cleanup retries.
- Attachment-only downloads with `no-store` and `nosniff` headers.

## Reporting

Before this repository is published, report security concerns directly to its maintainer. Once a public source repository exists, use its private security reporting channel.
