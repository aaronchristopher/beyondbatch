-- Beyond Batch Requests: PostgreSQL 16+ production foundation.
-- Validated in disposable development databases; not an applied production DB.
-- Run once as a dedicated migration owner. This file creates NO roles, grants,
-- credentials, extensions, mailbox access, or outbound messaging capability.
-- IDs are application-generated UUIDs; timestamps are absolute instants.

BEGIN;

CREATE SCHEMA bb;

CREATE FUNCTION bb.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE bb.tenants (
  id uuid PRIMARY KEY,
  entra_tenant_id uuid NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'pilot', 'active')),
  display_timezone text NOT NULL DEFAULT 'America/Chicago',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bb.principals (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  entra_object_id uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'service')),
  display_name text NOT NULL,
  email_address text,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entra_object_id)
);

CREATE TABLE bb.customers (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  display_name text NOT NULL,
  external_reference text,
  verified_domains text[] NOT NULL DEFAULT '{}',
  verified_contacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(verified_contacts) = 'array'),
  identity_status text NOT NULL DEFAULT 'needs_review' CHECK (identity_status IN ('needs_review', 'approved', 'inactive')),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (identity_status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX customer_external_ref_uq ON bb.customers (tenant_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE bb.customer_pm_assignments (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  primary_pm_id uuid NOT NULL,
  backup_pm_id uuid,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES bb.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, primary_pm_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, backup_pm_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, accepted_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (backup_pm_id IS NULL OR backup_pm_id <> primary_pm_id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX customer_one_open_pm_assignment ON bb.customer_pm_assignments (tenant_id, customer_id)
  WHERE effective_until IS NULL;

CREATE TABLE bb.role_grants (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role_name text NOT NULL CHECK (role_name IN ('president', 'pm', 'department_member', 'reviewer', 'security_admin', 'integration_worker')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant', 'customer', 'department', 'request')),
  customer_id uuid,
  department_key text,
  request_id uuid,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  reason text NOT NULL CHECK (length(reason) > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES bb.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES bb.principals(tenant_id, id),
  CHECK ((scope_kind = 'tenant' AND customer_id IS NULL AND department_key IS NULL AND request_id IS NULL)
      OR (scope_kind = 'customer' AND customer_id IS NOT NULL AND department_key IS NULL AND request_id IS NULL)
      OR (scope_kind = 'department' AND customer_id IS NULL AND department_key IS NOT NULL AND request_id IS NULL)
      OR (scope_kind = 'request' AND customer_id IS NULL AND department_key IS NULL AND request_id IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX role_grants_active_lookup ON bb.role_grants (tenant_id, principal_id, role_name)
  WHERE revoked_at IS NULL;

CREATE TABLE bb.mailbox_approvals (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  graph_user_id text NOT NULL,
  display_address text NOT NULL,
  mailbox_type text NOT NULL CHECK (mailbox_type IN ('user', 'shared')),
  access_mode text NOT NULL CHECK (access_mode IN ('exchange_rbac', 'legacy_application_access_policy', 'delegated_pilot')),
  entra_client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
  include_incoming boolean NOT NULL DEFAULT true,
  include_sent boolean NOT NULL DEFAULT true,
  history_start_at timestamptz NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  revoked_at timestamptz,
  approval_reference text,
  coverage_note text NOT NULL DEFAULT 'Coverage not verified',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, graph_user_id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (include_incoming OR include_sent),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reference IS NOT NULL)),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE TABLE bb.sync_folder_checkpoints (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  graph_folder_id text NOT NULL,
  folder_kind text NOT NULL CHECK (folder_kind IN ('inbox', 'sent', 'custom', 'deleted')),
  delta_cursor_ciphertext bytea,
  cursor_generation bigint NOT NULL DEFAULT 0 CHECK (cursor_generation >= 0),
  cursor_state text NOT NULL DEFAULT 'uninitialized' CHECK (cursor_state IN ('uninitialized', 'paging', 'current', 'reset_required', 'blocked')),
  last_success_at timestamptz,
  last_full_recovery_at timestamptz,
  coverage_from timestamptz,
  coverage_through timestamptz,
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, mailbox_id, graph_folder_id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES bb.mailbox_approvals(tenant_id, id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (coverage_through IS NULL OR (coverage_from IS NOT NULL AND coverage_through >= coverage_from))
);

CREATE TABLE bb.raw_blob_refs (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  storage_object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  media_type text NOT NULL,
  encryption_key_version_ref text NOT NULL,
  processing_status text NOT NULL DEFAULT 'quarantined' CHECK (processing_status IN ('quarantined', 'available', 'rejected', 'purged')),
  sensitivity text NOT NULL DEFAULT 'unclassified' CHECK (sensitivity IN ('unclassified', 'operational', 'restricted_hr', 'restricted_legal', 'personal', 'restricted_other')),
  retain_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, storage_object_key),
  CHECK ((processing_status = 'purged') = (purged_at IS NOT NULL)),
  CHECK (processing_status <> 'purged' OR NOT legal_hold)
);

CREATE TABLE bb.canonical_emails (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  internet_message_id text,
  dedup_version text NOT NULL,
  dedup_fingerprint text NOT NULL CHECK (dedup_fingerprint ~ '^[0-9a-f]{64}$'),
  sender_address text NOT NULL,
  recipients jsonb NOT NULL CHECK (jsonb_typeof(recipients) = 'array'),
  subject text NOT NULL DEFAULT '',
  sent_at timestamptz,
  first_observed_at timestamptz NOT NULL,
  direction text NOT NULL DEFAULT 'unknown' CHECK (direction IN ('incoming', 'outgoing', 'internal', 'unknown')),
  classification text NOT NULL DEFAULT 'unclassified' CHECK (classification IN ('unclassified', 'request', 'meaningful_response', 'acknowledgement', 'fyi', 'marketing', 'internal_discussion', 'delivery_failure')),
  sensitivity text NOT NULL DEFAULT 'unclassified' CHECK (sensitivity IN ('unclassified', 'operational', 'restricted_hr', 'restricted_legal', 'personal', 'restricted_other')),
  raw_blob_id uuid,
  normalized_body_blob_id uuid,
  reference_headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reference_headers) = 'object'),
  processing_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedup_version, dedup_fingerprint),
  FOREIGN KEY (tenant_id, raw_blob_id) REFERENCES bb.raw_blob_refs(tenant_id, id),
  FOREIGN KEY (tenant_id, normalized_body_blob_id) REFERENCES bb.raw_blob_refs(tenant_id, id)
);
-- Message-ID alone is NOT a uniqueness or request-correlation guarantee.
CREATE INDEX canonical_email_message_id_lookup ON bb.canonical_emails (tenant_id, internet_message_id)
  WHERE internet_message_id IS NOT NULL;

CREATE TABLE bb.mailbox_copies (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  canonical_email_id uuid NOT NULL,
  graph_immutable_id text NOT NULL,
  current_folder_id text NOT NULL,
  graph_conversation_id text,
  graph_change_key text,
  source_web_link text,
  received_at timestamptz,
  observed_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  deleted_observed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, mailbox_id, graph_immutable_id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES bb.mailbox_approvals(tenant_id, id),
  FOREIGN KEY (tenant_id, canonical_email_id) REFERENCES bb.canonical_emails(tenant_id, id),
  CHECK (last_seen_at >= observed_at)
);
CREATE INDEX mailbox_copy_email_lookup ON bb.mailbox_copies (tenant_id, canonical_email_id);
CREATE INDEX mailbox_copy_conversation_lookup ON bb.mailbox_copies (tenant_id, mailbox_id, graph_conversation_id)
  WHERE graph_conversation_id IS NOT NULL;

CREATE TABLE bb.email_attachments (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  canonical_email_id uuid NOT NULL,
  attachment_fingerprint text NOT NULL CHECK (attachment_fingerprint ~ '^[0-9a-f]{64}$'),
  original_filename text NOT NULL,
  attachment_kind text NOT NULL CHECK (attachment_kind IN ('file', 'attached_message', 'reference')),
  raw_blob_id uuid,
  extracted_text_blob_id uuid,
  reference_locator text,
  processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'quarantined', 'processed', 'unsupported', 'rejected')),
  parser_version text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, canonical_email_id, attachment_fingerprint),
  FOREIGN KEY (tenant_id, canonical_email_id) REFERENCES bb.canonical_emails(tenant_id, id),
  FOREIGN KEY (tenant_id, raw_blob_id) REFERENCES bb.raw_blob_refs(tenant_id, id),
  FOREIGN KEY (tenant_id, extracted_text_blob_id) REFERENCES bb.raw_blob_refs(tenant_id, id),
  CHECK (attachment_kind <> 'reference' OR reference_locator IS NOT NULL)
);

CREATE TABLE bb.requests (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  customer_id uuid,
  accountable_owner_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  request_text text NOT NULL,
  category text NOT NULL,
  product_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(product_references) = 'array'),
  order_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(order_references) = 'array'),
  state text NOT NULL DEFAULT 'needs_review' CHECK (state IN ('needs_review', 'open', 'acknowledged', 'working', 'waiting_internally', 'waiting_on_customer', 'answer_sent', 'resolved', 'cancelled')),
  publication_state text NOT NULL DEFAULT 'quarantined' CHECK (publication_state IN ('quarantined', 'approved', 'excluded')),
  sensitivity text NOT NULL DEFAULT 'unclassified' CHECK (sensitivity IN ('unclassified', 'operational', 'restricted_hr', 'restricted_legal', 'personal', 'restricted_other')),
  first_request_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_meaningful_response_at timestamptz,
  customer_promised_at timestamptz,
  internal_estimate_at timestamptz,
  estimate_kind text CHECK (estimate_kind IN ('next_input', 'customer_answer', 'resolution')),
  priority text NOT NULL DEFAULT 'unassessed' CHECK (priority IN ('unassessed', 'routine', 'high', 'critical')),
  priority_reason text,
  next_action text,
  current_requirements_version integer NOT NULL DEFAULT 1 CHECK (current_requirements_version > 0),
  closure_evidence_id uuid,
  closure_confirmed_by uuid,
  closure_confirmed_at timestamptz,
  closed_requirements_version integer,
  cancellation_reason text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES bb.customers(tenant_id, id),
  FOREIGN KEY (tenant_id, accountable_owner_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, closure_confirmed_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (state IN ('needs_review', 'cancelled') OR (customer_id IS NOT NULL AND accountable_owner_id IS NOT NULL)),
  CHECK (publication_state <> 'approved' OR (customer_id IS NOT NULL AND sensitivity = 'operational')),
  CHECK ((internal_estimate_at IS NULL) = (estimate_kind IS NULL)),
  CHECK (priority NOT IN ('high', 'critical') OR (priority_reason IS NOT NULL AND length(priority_reason) > 0)),
  CHECK ((state = 'resolved' AND closure_evidence_id IS NOT NULL AND closure_confirmed_by IS NOT NULL
          AND closure_confirmed_at IS NOT NULL AND closed_requirements_version IS NOT NULL AND closed_requirements_version = current_requirements_version)
      OR (state <> 'resolved' AND closure_evidence_id IS NULL AND closure_confirmed_by IS NULL
          AND closure_confirmed_at IS NULL AND closed_requirements_version IS NULL)),
  CHECK (state <> 'cancelled' OR (cancellation_reason IS NOT NULL AND length(cancellation_reason) > 0))
);
ALTER TABLE bb.role_grants ADD CONSTRAINT role_grant_request_fk
  FOREIGN KEY (tenant_id, request_id) REFERENCES bb.requests(tenant_id, id);
CREATE INDEX request_owner_queue ON bb.requests (tenant_id, accountable_owner_id, state, first_request_at);
CREATE INDEX request_customer_queue ON bb.requests (tenant_id, customer_id, state, first_request_at);
CREATE INDEX request_executive_scope ON bb.requests (tenant_id, customer_id, first_request_at)
  WHERE publication_state = 'approved' AND sensitivity = 'operational' AND state NOT IN ('resolved', 'cancelled');

CREATE TABLE bb.request_evidence (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  canonical_email_id uuid,
  blob_id uuid,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('customer_request', 'outbound_answer', 'internal_input', 'customer_confirmation', 'fulfillment_artifact', 'closure_confirmation', 'human_note')),
  source_locator jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_locator) = 'object'),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  requirements_version integer NOT NULL CHECK (requirements_version > 0),
  meaningful_for_request boolean NOT NULL DEFAULT false,
  human_confirmed_by uuid,
  human_confirmed_at timestamptz,
  assessment_version text NOT NULL,
  rationale text NOT NULL CHECK (length(rationale) > 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES bb.requests(tenant_id, id),
  FOREIGN KEY (tenant_id, canonical_email_id) REFERENCES bb.canonical_emails(tenant_id, id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES bb.raw_blob_refs(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, human_confirmed_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (canonical_email_id IS NOT NULL OR blob_id IS NOT NULL OR evidence_kind IN ('human_note', 'closure_confirmation')),
  CHECK ((human_confirmed_by IS NULL) = (human_confirmed_at IS NULL)),
  CHECK (NOT meaningful_for_request OR (evidence_kind = 'outbound_answer' AND canonical_email_id IS NOT NULL)),
  CHECK (evidence_kind <> 'closure_confirmation' OR human_confirmed_by IS NOT NULL)
);
ALTER TABLE bb.requests ADD CONSTRAINT request_closure_evidence_fk
  FOREIGN KEY (tenant_id, id, closure_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id);
CREATE INDEX request_evidence_timeline ON bb.request_evidence (tenant_id, request_id, observed_at, id);
CREATE UNIQUE INDEX request_email_evidence_once ON bb.request_evidence
  (tenant_id, request_id, canonical_email_id, evidence_kind, requirements_version, assessment_version)
  WHERE canonical_email_id IS NOT NULL;

CREATE TABLE bb.thread_link_proposals (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  candidate_request_id uuid NOT NULL,
  canonical_email_id uuid NOT NULL,
  proposal_version text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  contradictions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contradictions) = 'array'),
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'accepted', 'rejected', 'superseded')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  accepted_evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, candidate_request_id, canonical_email_id, proposal_version),
  FOREIGN KEY (tenant_id, candidate_request_id) REFERENCES bb.requests(tenant_id, id),
  FOREIGN KEY (tenant_id, canonical_email_id) REFERENCES bb.canonical_emails(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_request_id, accepted_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id),
  CHECK (review_state NOT IN ('accepted', 'rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL AND length(review_reason) > 0)),
  CHECK ((review_state = 'accepted') = (accepted_evidence_id IS NOT NULL))
);

CREATE TABLE bb.dependencies (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  department_key text NOT NULL,
  assigned_principal_id uuid,
  deliverable text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'accepted', 'working', 'blocked', 'delivered', 'verified', 'cancelled')),
  promised_at timestamptz,
  delivered_evidence_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES bb.requests(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_principal_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, delivered_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (state NOT IN ('delivered', 'verified') OR delivered_evidence_id IS NOT NULL),
  CHECK (state <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX department_dependency_queue ON bb.dependencies (tenant_id, department_key, state, promised_at);

CREATE TABLE bb.dependency_edges (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  request_id uuid NOT NULL,
  prerequisite_id uuid NOT NULL,
  dependent_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id, prerequisite_id, dependent_id),
  FOREIGN KEY (tenant_id, request_id, prerequisite_id) REFERENCES bb.dependencies(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id, dependent_id) REFERENCES bb.dependencies(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (prerequisite_id <> dependent_id)
);

CREATE TABLE bb.response_obligations (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('initial_request', 'customer_follow_up', 'recurring_update', 'reopened_request')),
  trigger_key text NOT NULL,
  trigger_evidence_id uuid,
  previous_obligation_id uuid,
  opened_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'fulfilled', 'withdrawn')),
  fulfilled_at timestamptz,
  fulfilled_by_evidence_id uuid,
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  withdrawal_reason text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, id),
  UNIQUE (tenant_id, request_id, trigger_key),
  FOREIGN KEY (tenant_id, request_id) REFERENCES bb.requests(tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, trigger_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id, previous_obligation_id) REFERENCES bb.response_obligations(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id, fulfilled_by_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, withdrawn_by) REFERENCES bb.principals(tenant_id, id),
  CHECK (due_at - opened_at = interval '24 hours'),
  CHECK (previous_obligation_id IS NULL OR previous_obligation_id <> id),
  CHECK (trigger_kind <> 'recurring_update' OR previous_obligation_id IS NOT NULL),
  CHECK (trigger_kind = 'recurring_update' OR trigger_evidence_id IS NOT NULL),
  CHECK ((state = 'open' AND fulfilled_at IS NULL AND fulfilled_by_evidence_id IS NULL
          AND withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawal_reason IS NULL)
      OR (state = 'fulfilled' AND fulfilled_at IS NOT NULL AND fulfilled_by_evidence_id IS NOT NULL
          AND withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawal_reason IS NULL)
      OR (state = 'withdrawn' AND fulfilled_at IS NULL AND fulfilled_by_evidence_id IS NULL
          AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_reason IS NOT NULL AND length(withdrawal_reason) > 0)),
  CHECK (fulfilled_at IS NULL OR fulfilled_at >= opened_at)
);
CREATE INDEX obligation_due_queue ON bb.response_obligations (tenant_id, due_at, request_id) WHERE state = 'open';

CREATE TABLE bb.audit_events (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  request_id uuid,
  actor_principal_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'worker', 'model_proposal')),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
  source_evidence_id uuid,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  sensitivity text NOT NULL DEFAULT 'unclassified' CHECK (sensitivity IN ('unclassified', 'operational', 'restricted_hr', 'restricted_legal', 'personal', 'restricted_other')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES bb.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES bb.requests(tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, source_evidence_id) REFERENCES bb.request_evidence(tenant_id, request_id, id),
  CHECK (source_evidence_id IS NULL OR request_id IS NOT NULL)
);
CREATE INDEX audit_request_history ON bb.audit_events (tenant_id, request_id, recorded_at, id);

CREATE TABLE bb.outbox (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  job_kind text NOT NULL CHECK (job_kind IN ('reconcile_request', 'process_email', 'process_attachment', 'review_link', 'refresh_projection', 'reminder_candidate')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'dead_letter')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, event_id) REFERENCES bb.audit_events(tenant_id, id),
  CHECK ((state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX outbox_ready_queue ON bb.outbox (tenant_id, available_at, id) WHERE state IN ('pending', 'leased');

CREATE TABLE bb.idempotency_records (
  tenant_id uuid NOT NULL REFERENCES bb.tenants(id),
  operation_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'completed')),
  result_event_id uuid,
  response_status integer,
  response_projection jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key),
  FOREIGN KEY (tenant_id, result_event_id) REFERENCES bb.audit_events(tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'completed' AND result_event_id IS NOT NULL AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 299)
      OR (state = 'started' AND result_event_id IS NULL AND response_status IS NULL AND response_projection IS NULL))
);

-- Immutable source associations/assessments are replaced with new records and
-- correcting events, not overwritten. Privileged migration/retention operations
-- remain outside the application and require their own reviewed procedure.
CREATE FUNCTION bb.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only relation %.% cannot be changed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON bb.audit_events
  FOR EACH ROW EXECUTE FUNCTION bb.reject_history_mutation();
CREATE TRIGGER request_evidence_append_only BEFORE UPDATE OR DELETE ON bb.request_evidence
  FOR EACH ROW EXECUTE FUNCTION bb.reject_history_mutation();

CREATE FUNCTION bb.validate_request_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bb.request_evidence%ROWTYPE; p bb.principals%ROWTYPE;
BEGIN
  IF NEW.state = 'resolved' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'resolved'
      OR NEW.closure_evidence_id IS DISTINCT FROM OLD.closure_evidence_id
      OR NEW.closure_confirmed_by IS DISTINCT FROM OLD.closure_confirmed_by
      OR NEW.closure_confirmed_at IS DISTINCT FROM OLD.closure_confirmed_at
      OR NEW.closed_requirements_version IS DISTINCT FROM OLD.closed_requirements_version) THEN
    SELECT * INTO e FROM bb.request_evidence
      WHERE tenant_id = NEW.tenant_id AND request_id = NEW.id AND id = NEW.closure_evidence_id;
    SELECT * INTO p FROM bb.principals
      WHERE tenant_id = NEW.tenant_id AND id = NEW.closure_confirmed_by;
    IF e.id IS NULL OR e.evidence_kind <> 'closure_confirmation'
       OR e.human_confirmed_by IS DISTINCT FROM NEW.closure_confirmed_by
       OR e.human_confirmed_at IS DISTINCT FROM NEW.closure_confirmed_at
       OR e.requirements_version IS DISTINCT FROM NEW.current_requirements_version
       OR p.id IS NULL OR p.principal_type <> 'user' OR p.status <> 'active' THEN
      RAISE EXCEPTION 'resolution requires current, matching confirmation by an active human principal';
    END IF;
    IF EXISTS (SELECT 1 FROM bb.response_obligations
         WHERE tenant_id = NEW.tenant_id AND request_id = NEW.id
           AND (state = 'open' OR (trigger_kind IN ('initial_request', 'customer_follow_up', 'reopened_request') AND state <> 'fulfilled')))
       OR EXISTS (SELECT 1 FROM bb.dependencies WHERE tenant_id = NEW.tenant_id AND request_id = NEW.id AND state NOT IN ('verified', 'cancelled')) THEN
      RAISE EXCEPTION 'resolution requires answered inbound obligations, retired recurring updates and verified dependency work';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_verified_closure BEFORE INSERT OR UPDATE ON bb.requests
  FOR EACH ROW EXECUTE FUNCTION bb.validate_request_closure();

CREATE FUNCTION bb.validate_obligation_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bb.request_evidence%ROWTYPE; m bb.canonical_emails%ROWTYPE; r bb.requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM bb.requests WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id FOR UPDATE;
  IF NEW.state = 'open' AND r.state IN ('resolved', 'cancelled') THEN
    RAISE EXCEPTION 'reopen the request before recording an unanswered obligation, including a late-discovered preclosure ask';
  END IF;
  IF NEW.state = 'fulfilled' THEN
    SELECT * INTO e FROM bb.request_evidence
      WHERE tenant_id = NEW.tenant_id AND request_id = NEW.request_id AND id = NEW.fulfilled_by_evidence_id;
    SELECT * INTO m FROM bb.canonical_emails
      WHERE tenant_id = NEW.tenant_id AND id = e.canonical_email_id;
    IF e.id IS NULL OR NOT e.meaningful_for_request OR e.evidence_kind <> 'outbound_answer'
       OR m.id IS NULL OR m.direction <> 'outgoing' OR m.classification <> 'meaningful_response' OR m.sent_at IS NULL
       OR NEW.fulfilled_at IS DISTINCT FROM m.sent_at THEN
      RAISE EXCEPTION 'response obligation requires request-specific meaningful outgoing email evidence at its observed sent time';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER obligation_meaningful_response BEFORE INSERT OR UPDATE ON bb.response_obligations
  FOR EACH ROW EXECUTE FUNCTION bb.validate_obligation_fulfillment();

-- This is tenant isolation, NOT full request/department/attachment authorization.
-- The API must authenticate Entra, resolve the trusted tenant and BEGIN before
-- SET LOCAL app.tenant_id = '<verified internal tenant UUID>'. No client value.
-- FORCE RLS also subjects an ordinary table owner to policies; superusers and
-- BYPASSRLS roles are explicitly forbidden for web/worker connections.
ALTER TABLE bb.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE bb.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bb.tenants
  USING (id = bb.current_tenant_id()) WITH CHECK (id = bb.current_tenant_id());
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'principals', 'customers', 'customer_pm_assignments', 'role_grants',
    'mailbox_approvals', 'sync_folder_checkpoints', 'raw_blob_refs',
    'canonical_emails', 'mailbox_copies', 'email_attachments', 'requests',
    'request_evidence', 'thread_link_proposals', 'dependencies', 'dependency_edges',
    'response_obligations', 'audit_events', 'outbox', 'idempotency_records'
  ] LOOP
    EXECUTE format('ALTER TABLE bb.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE bb.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('CREATE POLICY tenant_boundary ON bb.%I USING (tenant_id = bb.current_tenant_id()) WITH CHECK (tenant_id = bb.current_tenant_id())', relation_name);
  END LOOP;
END;
$$;

-- Sanitized operational projection. No subjects, bodies, blob locations, raw
-- evidence, notes, personal addresses or restricted-record existence counts.
-- security_invoker requires PostgreSQL 15+ and respects the caller's RLS.
CREATE VIEW bb.executive_open_requests WITH (security_barrier = true, security_invoker = true) AS
SELECT r.tenant_id, r.id AS internal_request_id, r.customer_id,
       c.display_name AS customer_name, r.title, r.accountable_owner_id,
       r.state, r.first_request_at, r.last_meaningful_response_at,
       r.customer_promised_at, r.internal_estimate_at, r.estimate_kind,
       r.priority, r.next_action,
       (SELECT min(o.due_at) FROM bb.response_obligations o
          WHERE o.tenant_id = r.tenant_id AND o.request_id = r.id AND o.state = 'open') AS next_response_due_at,
       (SELECT count(*) FROM bb.response_obligations o
          WHERE o.tenant_id = r.tenant_id AND o.request_id = r.id AND o.state = 'open' AND o.due_at < now()) AS overdue_response_count
FROM bb.requests r JOIN bb.customers c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
WHERE r.publication_state = 'approved' AND r.sensitivity = 'operational'
  AND c.identity_status = 'approved' AND r.state NOT IN ('resolved', 'cancelled');

COMMIT;
