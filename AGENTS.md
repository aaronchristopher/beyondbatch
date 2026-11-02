# BeyondBatch development

Customer ticketing is a BeyondBatch module. Its canonical source is `modules/customer-ticketing/` in this repository. Implement new ticketing behavior here; do not create a separate application repository or independently edit a generated review copy.

- Keep the existing manufacturing requirements in `docs/` intact unless the task changes them.
- Keep module-specific domain, adapters, UI, schema, tests and operational documentation in the module. Add shared infrastructure only when another implemented module actually needs it.
- The review build is generated from `public/` and fictional fixture projections. `dist/` and deployment account configuration are not source.
- Run `npm test`, `npm run check` and `npm run build:ticketing-review` for changes affecting module packaging or its review build. Use focused tests for narrower changes.
- This repository is public. Never commit mailbox data, attachments, credentials, real tenant/user identifiers, runtime databases or deployment account records. Test fixtures must be explicitly fictional.
- Do not portray the demo persona switch as authentication or the mocked adapters as live integrations. Production startup remains blocked until the documented readiness gates pass.
- A 24-hour response obligation uses elapsed time. Opening Outlook, drafts, acknowledgments and internal activity do not prove a meaningful customer response or final resolution.
