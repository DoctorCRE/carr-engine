CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

SET statement_timeout = 0;

SET lock_timeout = 0;

SET idle_in_transaction_session_timeout = 0;

SET transaction_timeout = 0;

SET client_encoding = 'UTF8';

SET standard_conforming_strings = on;

SELECT pg_catalog.set_config('search_path', '', false);

SET check_function_bodies = false;

SET xmloption = content;

SET client_min_messages = warning;

SET row_security = off;

CREATE SCHEMA ops;

CREATE SCHEMA IF NOT EXISTS public;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.candidate_pool (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT prospect_pool_id_not_null NOT NULL,
    source text CONSTRAINT prospect_pool_source_not_null NOT NULL,
    source_key text CONSTRAINT prospect_pool_source_key_not_null NOT NULL,
    source_seq integer,
    source_row jsonb CONSTRAINT prospect_pool_source_row_not_null NOT NULL,
    name text CONSTRAINT prospect_pool_name_not_null NOT NULL,
    org_name text,
    vertical text,
    address text,
    city text,
    county text,
    state text,
    email text,
    phone text,
    segment text,
    segment_play text,
    score numeric(5,2),
    score_basis text,
    est_lease_event date,
    est_basis text,
    status text DEFAULT 'pool'::text CONSTRAINT prospect_pool_status_not_null NOT NULL,
    promoted_lead_id uuid,
    dup_tier text,
    dup_subject_type text,
    dup_subject_id uuid,
    dup_ref text,
    dup_basis text,
    dup_do_not_contact boolean DEFAULT false CONSTRAINT prospect_pool_dup_do_not_contact_not_null NOT NULL,
    version integer DEFAULT 1 CONSTRAINT prospect_pool_version_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT prospect_pool_created_at_not_null NOT NULL,
    created_by uuid CONSTRAINT prospect_pool_created_by_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT prospect_pool_updated_at_not_null NOT NULL,
    updated_by uuid CONSTRAINT prospect_pool_updated_by_not_null NOT NULL,
    declined_at timestamp with time zone,
    declined_by uuid,
    decline_reason text,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    CONSTRAINT candidate_pool_declined_has_reason CHECK (((status = 'declined'::text) = ((decline_reason IS NOT NULL) AND (decline_reason <> ''::text)))),
    CONSTRAINT candidate_pool_declined_has_stamp CHECK (((status = 'declined'::text) = (declined_at IS NOT NULL))),
    CONSTRAINT candidate_pool_status_check CHECK ((status = ANY (ARRAY['pool'::text, 'promoted'::text, 'suppressed_dup'::text, 'declined'::text, 'expired'::text, 'confirmed'::text]))),
    CONSTRAINT pool_dup_tier_pairs_with_pointer CHECK (((dup_tier IS NULL) = (dup_subject_type IS NULL))),
    CONSTRAINT pool_promoted_has_lead CHECK (((status = 'promoted'::text) = (promoted_lead_id IS NOT NULL))),
    CONSTRAINT pool_suppressed_iff_tier_suppressed CHECK (((status = 'suppressed_dup'::text) = (COALESCE(dup_tier, ''::text) = 'suppressed'::text))),
    CONSTRAINT prospect_pool_dup_subject_type_check CHECK ((dup_subject_type = ANY (ARRAY['lead'::text, 'client'::text]))),
    CONSTRAINT prospect_pool_dup_tier_check CHECK ((dup_tier = ANY (ARRAY['suppressed'::text, 'review'::text])))
);

CREATE TABLE public.actor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    email text,
    active boolean DEFAULT true NOT NULL,
    phone text,
    CONSTRAINT actor_kind_check CHECK ((kind = ANY (ARRAY['human'::text, 'automation'::text, 'system'::text])))
);

CREATE FUNCTION public.campaign_channels_valid() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare bad text;
begin
  select string_agg(ch, ', ') into bad
    from unnest(new.channels) ch
   where ch not in (select slug from marketing_subject
                     where subject_type = 'platform' and retired_at is null);
  if bad is not null then
    raise exception 'campaign.channels holds unknown platform slug(s): %. Known live '
                    'platforms: %. Register a new platform in marketing_subject before '
                    'naming it here.', bad,
                    (select string_agg(slug, ', ' order by slug) from marketing_subject
                      where subject_type = 'platform' and retired_at is null);
  end if;
  return new;
end $$;

CREATE FUNCTION public.carr_business_date(instant timestamp with time zone DEFAULT CURRENT_TIMESTAMP) RETURNS date
    LANGUAGE sql STABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$ select (instant at time zone 'America/Chicago')::date $$;

CREATE FUNCTION public.carr_business_days(a date, b date) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case when a is null or b is null then null
         else (case when b >= a then 1 else -1 end) * (
           select count(*)::int
             from generate_series(least(a,b), greatest(a,b) - 1, interval '1 day') d
            where extract(isodow from d) < 6)
         end;
$$;

CREATE FUNCTION public.carr_confirm_partner_touch() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare
  v_owner text;
begin
  if new.confirmed_at is not null or new.status not in ('open', 'pool') then return new; end if;
  if tg_op = 'INSERT' then
    v_owner := case tg_table_name
      when 'next_action' then (select a.slug from public.actor a where a.id = (to_jsonb(new) ->> 'owner_id')::uuid)
      when 'loop_item' then to_jsonb(new) ->> 'owner' end;
    if public.carr_is_partner_made(new.created_by, v_owner) then
      new.confirmed_at := now();
      new.confirmed_by := new.created_by;
      return new;
    end if;
  end if;
  if public.carr_is_partner_actor(new.updated_by) then
    new.confirmed_at := now();
    new.confirmed_by := new.updated_by;
  end if;
  return new;
end $$;

CREATE FUNCTION public.carr_is_partner_actor(p_actor uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ select exists (select 1 from public.actor a where a.id = p_actor and a.slug in ('partner_one', 'partner_two')) $$;

CREATE FUNCTION public.carr_is_partner_made(p_created_by uuid, p_owner text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ select exists (select 1 from public.actor a where a.id = p_created_by and (a.slug in ('partner_one', 'partner_two')
          or (a.slug in ('partner_one-local', 'partner_two-local')
              and (p_owner is null or lower(p_owner) in ('partner_one', 'partner_two', 'partner_one-local', 'partner_two-local', 'joint'))))) $$;

CREATE FUNCTION public.email_touch_application_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if old.verb='log-activity' and old.new_value ? 'email_application' then
    raise exception 'email_touch_application_immutable' using errcode='23514';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

CREATE FUNCTION public.enforce_allocation_tree() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
begin

  if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
    raise exception using errcode='25001',
      message='commission allocation tree writes require READ COMMITTED isolation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-allocation:'||new.commission_id::text,757));
  if new.parent_id is not null and exists (
    with recursive ancestors as (
      select a.id,a.parent_id from public.commission_allocation a where a.id=new.parent_id
      union
      select a.id,a.parent_id from public.commission_allocation a join ancestors p on a.id=p.parent_id
    ) select 1 from ancestors where id=new.id
  ) then raise exception using errcode='23514',message='commission allocation parent would create a cycle'; end if;
  return new;
end $$;

CREATE FUNCTION public.guard_email_lifecycle_action() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare context jsonb;
begin
  select a.email_context into context from public.activity a where a.id=new.activity_id for update;
  if coalesce(context#>>'{lifecycle,state}','live') <> 'live' then
    raise exception 'email_not_live: source mail is terminal' using errcode='23514';
  end if;
  return new;
end $$;

CREATE FUNCTION public.mark_retrieval_mappings_for_repair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'active' and new.status <> 'active' then
    update doctrine_concept_mapping
       set status = 'needs_repair', repair_reason = 'target section is no longer active',
           version = version + 1, updated_at = now()
     where section_id = new.id and status = 'approved';
  end if;
  return new;
end $$;

CREATE FUNCTION public.org_identity_key(p_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when p_name is null                then null
    when btrim(p_name) = ''            then null
    when btrim(p_name) like '(%'       then null   
    when p_name ~* '\mtbd\M'
      or p_name ~* '\munknown\M'
      or p_name ~* '\mn/a\M'           then null   
    else lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
  end
$$;

CREATE FUNCTION public.revise_deal_client_need() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
 if row(new.deal_id,new.vendor_id,new.description,new.applicability,new.source_ref,new.source_revision,
        new.observed_at,new.fresh_until,new.restriction,new.withdrawn)
    is distinct from row(old.deal_id,old.vendor_id,old.description,old.applicability,old.source_ref,old.source_revision,
        old.observed_at,old.fresh_until,old.restriction,old.withdrawn) then
  new.version := old.version+1;
  new.revision := old.revision+1;
  new.approved_revision := null; new.approved_client_id := null;
  new.approved_by := null; new.approved_at := null;
 end if;
 new.updated_at := clock_timestamp();
 return new;
end $$;

CREATE FUNCTION public.trg_availability_norm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.rate_amount is not null
     and new.rate_basis in ('usd_mo_gross','usd_yr_gross')
     and new.rate_norm_gross_sf_yr is null then
    new.norm_owed := true;                       
  end if;
  return new;
end $$;

CREATE FUNCTION public.trg_deal_participant_side() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare s text;
begin
  select side into s from public.participant_role where slug = new.role;

  if s = 'actor' then
    if new.actor_id is null then
      raise exception 'deal_participant.role=% is an ACTOR-side role (a CARR employee) and '
                      'needs actor_id. See participant_role.side.', new.role;
    end if;
    if new.party_id is not null then
      raise exception 'deal_participant.role=% is an ACTOR-side role and must NOT carry '
                      'party_id. role=''lead'' means the deal''s OWNING AGENT (partner_one or partner_two), '
                      'not the client — v_deal_board reads lead_owner off actor_id and never '
                      'looks at party_id. Writing the client''s party here makes one row '
                      'assert two different owners. If you want the client''s person on the '
                      'deal, that is role=''client_contact'', or just follow '
                      'deal -> client -> client.party_id, which is already exact and 1:1.',
                      new.role;
    end if;

  elsif s = 'party' then
    if new.party_id is null then
      raise exception 'deal_participant.role=% is a PARTY-side role (someone outside CARR) '
                      'and needs party_id. See participant_role.side.', new.role;
    end if;
    if new.actor_id is not null then
      raise exception 'deal_participant.role=% is a PARTY-side role and must NOT carry '
                      'actor_id — an actor is a CARR employee and this role is a '
                      'counterparty.', new.role;
    end if;
  end if;

  return new;
end
$$;

CREATE FUNCTION public.tool_call_expire() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  delete from public.tool_call t
   where t.idempotency_key = new.idempotency_key
     and not (t.verb in ('review-and-triage', 'accept-ready-plan', 'accept-outcome-feedback')
       or t.idempotency_key like 'rw02-%' or t.idempotency_key like 'calcap-%')
     and t.created_at < now() - interval '30 days';
  delete from public.tool_call t where t.idempotency_key in (
    select o.idempotency_key from public.tool_call o
     where not (o.verb in ('review-and-triage', 'accept-ready-plan', 'accept-outcome-feedback')
       or o.idempotency_key like 'rw02-%' or o.idempotency_key like 'calcap-%')
       and o.created_at < now() - interval '30 days'
     order by o.created_at limit 20 for update skip locked);
  return new;
end
$$;

CREATE FUNCTION public.trg_touch_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  new.version    := old.version + 1;
  return new;
end $$;

CREATE FUNCTION public.vendor_market_canonical_key() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.vendor_market_key(key,market_slug) values(new.slug,new.slug);
  return new;
end $$;

CREATE TABLE ops.client_portal (
    slug text NOT NULL,
    client_id uuid NOT NULL,
    deal_id uuid NOT NULL,
    password_hash text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    attempt_window_started_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT client_portal_failed_attempts_check CHECK (((failed_attempts >= 0) AND (failed_attempts <= 5))),
    CONSTRAINT client_portal_password_hash_check CHECK ((password_hash ~ '^\$2[aby]\$12\$[./A-Za-z0-9]{53}$'::text)),
    CONSTRAINT client_portal_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text))
);

CREATE TABLE ops.requirement_request (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_tenant_id text NOT NULL,
    deal_id uuid NOT NULL,
    row_key text NOT NULL,
    owner text NOT NULL,
    due_on date NOT NULL,
    document_type text NOT NULL,
    source jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    recipient_email text,
    thread_activity_id uuid,
    fulfilled_at timestamp with time zone,
    fulfilled_by uuid,
    evidence_attachment_id uuid,
    CONSTRAINT requirement_fulfillment_complete CHECK ((((fulfilled_at IS NULL) AND (fulfilled_by IS NULL) AND (evidence_attachment_id IS NULL)) OR ((fulfilled_at IS NOT NULL) AND (fulfilled_by IS NOT NULL) AND (evidence_attachment_id IS NOT NULL)))),
    CONSTRAINT requirement_request_organization_tenant_id_check CHECK ((organization_tenant_id = 'example-tenant'::text)),
    CONSTRAINT requirement_request_owner_check CHECK (((length(btrim(owner)) >= 1) AND (length(btrim(owner)) <= 100))),
    CONSTRAINT requirement_request_row_key_check CHECK ((row_key ~ '^[a-z][a-z0-9_]{0,79}$'::text)),
    CONSTRAINT requirement_request_source_check CHECK ((jsonb_typeof(source) = 'object'::text))
);

CREATE TABLE ops.requirement_upload_grant (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    organization_tenant_id text NOT NULL,
    deal_id uuid NOT NULL,
    row_key text NOT NULL,
    action text DEFAULT 'upload'::text NOT NULL,
    token_sha256 text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT requirement_upload_grant_action_check CHECK ((action = 'upload'::text)),
    CONSTRAINT requirement_upload_grant_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '1 day'::interval)))),
    CONSTRAINT requirement_upload_grant_token_sha256_check CHECK ((token_sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE ops.requirement_upload_receipt (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    grant_id uuid NOT NULL,
    request_id uuid NOT NULL,
    r2_key text NOT NULL,
    sha256 text NOT NULL,
    bytes integer NOT NULL,
    mime text NOT NULL,
    state text DEFAULT 'quarantined'::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT requirement_upload_receipt_bytes_check CHECK (((bytes >= 1) AND (bytes <= 1048576))),
    CONSTRAINT requirement_upload_receipt_mime_check CHECK ((mime = 'application/pdf'::text)),
    CONSTRAINT requirement_upload_receipt_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requirement_upload_receipt_state_check CHECK ((state = 'quarantined'::text))
);

CREATE TABLE public.rule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    statement text NOT NULL,
    human_quote text,
    taught_by uuid NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    personal_to uuid,
    status text DEFAULT 'proposed'::text NOT NULL,
    activated_by uuid,
    activated_at timestamp with time zone,
    enforcement text DEFAULT 'prose'::text NOT NULL,
    supersedes uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_by uuid,
    retired_at timestamp with time zone,
    card jsonb,
    CONSTRAINT rule_card_check CHECK (((card IS NULL) OR ((jsonb_typeof(card) = 'object'::text) AND (card ? 'id'::text) AND (NOT (card ? 'wording'::text))))),
    CONSTRAINT rule_check CHECK (((status <> 'active'::text) OR (activated_by IS NOT NULL))),
    CONSTRAINT rule_enforcement_check CHECK ((enforcement = ANY (ARRAY['prose'::text, 'checklist'::text, 'gate'::text, 'constraint'::text, 'code'::text]))),
    CONSTRAINT rule_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'active'::text, 'retired'::text, 'superseded'::text])))
);

CREATE TABLE public.loop_block (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rel_path text NOT NULL,
    kind text NOT NULL,
    seq integer NOT NULL,
    block_key text,
    prose_md text DEFAULT ''::text NOT NULL,
    header_cols text[],
    col_order text[],
    renders_closed boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT loop_block_header_needs_columns CHECK (((header_cols IS NULL) OR (col_order IS NOT NULL))),
    CONSTRAINT loop_block_kind_check CHECK ((kind = ANY (ARRAY['open_loop'::text, 'team_loop'::text, 'action_required'::text, 'idea'::text]))),
    CONSTRAINT loop_block_prose_has_no_columns CHECK (((block_key IS NULL) = (col_order IS NULL)))
);

CREATE TABLE public.loop_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    number text NOT NULL,
    block_id uuid NOT NULL,
    render_seq integer NOT NULL,
    col_order text[],
    title text,
    body text,
    owner text,
    since_text text,
    unblocks text,
    source_note text,
    closed_text text,
    outcome text,
    extra_cells jsonb DEFAULT '{}'::jsonb NOT NULL,
    marker text DEFAULT 'none'::text NOT NULL,
    marker_literal text,
    due_on date,
    drift_critical boolean DEFAULT false NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    close_outcome text,
    closed_by uuid,
    closed_at timestamp with time zone,
    tier text NOT NULL,
    personal_to uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    domain text,
    blocker_class text,
    blocker_detail text,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    CONSTRAINT loop_item_blocker_class_known CHECK (((blocker_class IS NULL) OR (blocker_class = ANY (ARRAY['human_only'::text, 'counterparty'::text, 'ruling'::text, 'external_event'::text, 'other_lane'::text, 'capability'::text])))),
    CONSTRAINT loop_item_blocker_detail_present CHECK (((blocker_class IS NULL) OR ((blocker_detail IS NOT NULL) AND (length(btrim(blocker_detail)) >= 12)))),
    CONSTRAINT loop_item_closed_has_outcome CHECK (((status = 'open'::text) OR (close_outcome IS NOT NULL))),
    CONSTRAINT loop_item_closed_stamped CHECK (((status = 'open'::text) = (closed_at IS NULL))),
    CONSTRAINT loop_item_kind_check CHECK ((kind = ANY (ARRAY['open_loop'::text, 'team_loop'::text, 'action_required'::text, 'idea'::text]))),
    CONSTRAINT loop_item_marker_check CHECK ((marker = ANY (ARRAY['bell'::text, 'dated'::text, 'decision'::text, 'none'::text]))),
    CONSTRAINT loop_item_owner_known CHECK (((owner IS NULL) OR (owner = ANY (ARRAY['partner_one'::text, 'partner_two'::text, 'claude'::text, 'joint'::text])))),
    CONSTRAINT loop_item_personal_tier CHECK (((tier = 'personal'::text) = (personal_to IS NOT NULL))),
    CONSTRAINT loop_item_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'dropped'::text, 'expired'::text]))),
    CONSTRAINT loop_item_tier_check CHECK ((tier = ANY (ARRAY['personal'::text, 'shared'::text])))
);

CREATE TABLE public.doctrine_document (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    content_class text NOT NULL,
    visibility text DEFAULT 'shared'::text NOT NULL,
    owner_actor_id uuid,
    review_policy_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title_search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || replace(slug, '-'::text, ' '::text)))) STORED,
    CONSTRAINT doctrine_document_content_class_check CHECK ((content_class = ANY (ARRAY['playbook'::text, 'sop'::text, 'index'::text, 'reference'::text, 'dossier_narrative'::text, 'distillation'::text, 'rule'::text]))),
    CONSTRAINT doctrine_document_visibility_check CHECK ((visibility = ANY (ARRAY['shared'::text, 'personal'::text])))
);

CREATE TABLE public.doctrine_section (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    section_key text NOT NULL,
    title text,
    ordinal integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_revision_id uuid,
    current_version bigint DEFAULT 0 NOT NULL,
    body_hash text,
    review_after timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title_search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || replace(section_key, '-'::text, ' '::text)))) STORED,
    CONSTRAINT doctrine_section_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))
);

CREATE TABLE public.doctrine_gate_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    change_set_id uuid,
    dry_run boolean DEFAULT false NOT NULL,
    actor_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    result text,
    report jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT doctrine_gate_run_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text])))
);

CREATE TABLE public.doctrine_concept_mapping (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    concept_id uuid NOT NULL,
    section_id uuid NOT NULL,
    role text NOT NULL,
    weight numeric(5,4) DEFAULT 1 NOT NULL,
    rationale text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    review_after timestamp with time zone,
    proposer_id uuid NOT NULL,
    approver_id uuid,
    approved_at timestamp with time zone,
    retired_at timestamp with time zone,
    repair_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctrine_concept_mapping_check CHECK ((((status = 'approved'::text) = ((approver_id IS NOT NULL) AND (approved_at IS NOT NULL))) OR (status = ANY (ARRAY['retired'::text, 'needs_repair'::text])))),
    CONSTRAINT doctrine_concept_mapping_rationale_check CHECK ((btrim(rationale) <> ''::text)),
    CONSTRAINT doctrine_concept_mapping_role_check CHECK ((role = ANY (ARRAY['governs'::text, 'supports'::text]))),
    CONSTRAINT doctrine_concept_mapping_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'retired'::text, 'needs_repair'::text]))),
    CONSTRAINT doctrine_concept_mapping_weight_check CHECK (((weight > (0)::numeric) AND (weight <= (1)::numeric)))
);

CREATE TABLE public.retrieval_concept (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    concept_key text NOT NULL,
    label text NOT NULL,
    definition text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    review_after timestamp with time zone,
    proposer_id uuid NOT NULL,
    approver_id uuid,
    approved_at timestamp with time zone,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retrieval_concept_check CHECK ((((status = 'approved'::text) = ((approver_id IS NOT NULL) AND (approved_at IS NOT NULL))) OR (status = 'retired'::text))),
    CONSTRAINT retrieval_concept_concept_key_check CHECK ((concept_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT retrieval_concept_definition_check CHECK ((btrim(definition) <> ''::text)),
    CONSTRAINT retrieval_concept_label_check CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT retrieval_concept_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'retired'::text])))
);

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    sha256 text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL,
    summary text NOT NULL,
    detail text,
    owed text,
    deal_id uuid,
    client_id uuid,
    lead_id uuid,
    vendor_id uuid,
    source text DEFAULT 'stated'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    connected boolean,
    email_source jsonb,
    email_context jsonb,
    email_identity jsonb,
    calendar_event_key text,
    party_id uuid,
    CONSTRAINT activity_email_context_object CHECK (((email_context IS NULL) OR (jsonb_typeof(email_context) = 'object'::text))),
    CONSTRAINT activity_email_identity_check CHECK ((((email_identity IS NULL) OR ((kind = ANY (ARRAY['email_in'::text, 'email_out'::text])) AND (jsonb_typeof(email_identity) = 'object'::text) AND (email_identity ?& ARRAY['mailbox_owner'::text, 'mailbox_account'::text, 'item_id'::text, 'subject'::text]) AND ((email_identity ->> 'mailbox_owner'::text) = ANY (ARRAY['partner_one'::text, 'partner_two'::text])) AND ((length((email_identity ->> 'mailbox_account'::text)) >= 3) AND (length((email_identity ->> 'mailbox_account'::text)) <= 254)) AND ((length((email_identity ->> 'item_id'::text)) >= 1) AND (length((email_identity ->> 'item_id'::text)) <= 500)) AND (length((email_identity ->> 'subject'::text)) > 0))) IS TRUE)),
    CONSTRAINT activity_email_source_check CHECK ((((email_source IS NULL) OR ((kind = 'email_in'::text) AND (jsonb_typeof(email_source) = 'object'::text) AND (email_source ?& ARRAY['mailbox_owner'::text, 'sender_email'::text]) AND ((email_source ->> 'mailbox_owner'::text) = ANY (ARRAY['partner_one'::text, 'partner_two'::text])) AND ((email_source ->> 'sender_email'::text) ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'::text))) IS TRUE))
);

CREATE TABLE public.activity_kind (
    slug text NOT NULL,
    label text NOT NULL,
    is_contact boolean NOT NULL
);

CREATE TABLE public.agent_profile (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_key text NOT NULL,
    display_name text NOT NULL,
    charter jsonb DEFAULT '[]'::jsonb NOT NULL,
    current_model text,
    current_desk text,
    sponsor_scope text DEFAULT 'shared'::text NOT NULL,
    status text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_profile_charter_check CHECK ((jsonb_typeof(charter) = 'array'::text)),
    CONSTRAINT agent_profile_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 60))),
    CONSTRAINT agent_profile_profile_key_check CHECK ((profile_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'::text)),
    CONSTRAINT agent_profile_status_check CHECK ((status = ANY (ARRAY['active'::text, 'unstaffed'::text, 'parked'::text])))
);

CREATE TABLE public.agreement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    kind text NOT NULL,
    signed_on date,
    expires_on date,
    tail_months integer,
    status text NOT NULL,
    doc_attachment uuid,
    note text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT agreement_kind_check CHECK ((kind = ANY (ARRAY['etl'::text, 'buyer_rep'::text, 'listing_referral'::text, 'other'::text]))),
    CONSTRAINT agreement_status_check CHECK ((status = ANY (ARRAY['none_deliberate'::text, 'draft'::text, 'sent'::text, 'signed'::text, 'expired'::text]))),
    CONSTRAINT agreement_tail_months_check CHECK (((tail_months >= 0) AND (tail_months <= 36)))
);

CREATE TABLE public.attachment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    r2_key text NOT NULL,
    filename text NOT NULL,
    mime text NOT NULL,
    sha256 text NOT NULL,
    bytes bigint NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL
);

CREATE TABLE public.availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    status text NOT NULL,
    rate_amount numeric(12,2),
    rate_basis text,
    rate_norm_sf_yr numeric(12,2) GENERATED ALWAYS AS (
CASE rate_basis
    WHEN 'usd_sf_yr'::text THEN rate_amount
    WHEN 'usd_sf_mo'::text THEN (rate_amount * (12)::numeric)
    ELSE NULL::numeric
END) STORED,
    rate_norm_gross_sf_yr numeric(12,2),
    norm_owed boolean DEFAULT false NOT NULL,
    opex_sf_yr numeric(8,2),
    available_on date,
    note text,
    CONSTRAINT availability_check CHECK (((rate_amount IS NULL) OR (rate_basis IS NOT NULL))),
    CONSTRAINT availability_opex_sf_yr_check CHECK (((opex_sf_yr >= (0)::numeric) AND (opex_sf_yr <= (60)::numeric))),
    CONSTRAINT availability_rate_amount_check CHECK ((rate_amount > (0)::numeric)),
    CONSTRAINT availability_rate_basis_check CHECK ((rate_basis = ANY (ARRAY['usd_sf_yr'::text, 'usd_sf_mo'::text, 'usd_mo_gross'::text, 'usd_yr_gross'::text]))),
    CONSTRAINT availability_rate_norm_gross_sf_yr_check CHECK (((rate_norm_gross_sf_yr IS NULL) OR ((rate_norm_gross_sf_yr >= (2)::numeric) AND (rate_norm_gross_sf_yr <= (250)::numeric)))),
    CONSTRAINT availability_rate_norm_sf_yr_check CHECK (((rate_norm_sf_yr IS NULL) OR ((rate_norm_sf_yr >= (2)::numeric) AND (rate_norm_sf_yr <= (250)::numeric)))),
    CONSTRAINT availability_status_check CHECK ((status = ANY (ARRAY['available'::text, 'pending'::text, 'leased'::text, 'off_market'::text])))
);

CREATE TABLE public.building (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parcel_id uuid,
    address text NOT NULL,
    city text,
    state text,
    zip text,
    name text,
    class text,
    sub_type text,
    year_built integer,
    stories integer,
    status text,
    status_source text,
    merged_into uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT building_stories_check CHECK (((stories >= 1) AND (stories <= 60))),
    CONSTRAINT building_year_built_check CHECK (((year_built >= 1800) AND (year_built <= 2100)))
);

CREATE TABLE public.building_ownership (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    building_id uuid NOT NULL,
    party_id uuid NOT NULL,
    kind text NOT NULL,
    from_on date,
    to_on date,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT building_ownership_kind_check CHECK ((kind = ANY (ARRAY['owner'::text, 'landlord_rep'::text, 'property_manager'::text, 'listing_agent'::text])))
);

CREATE TABLE public.cadence_rule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lane text NOT NULL,
    subject_type text NOT NULL,
    trigger text NOT NULL,
    interval_days integer,
    action_template text,
    active boolean DEFAULT true NOT NULL,
    status_filter text[],
    CONSTRAINT cadence_rule_subject_type_check CHECK ((subject_type = ANY (ARRAY['deal'::text, 'client'::text, 'lead'::text, 'vendor'::text]))),
    CONSTRAINT cadence_rule_trigger_check CHECK ((trigger = ANY (ARRAY['on_complete'::text, 'on_date'::text])))
);

CREATE TABLE public.campaign (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    goal text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    success_criterion text NOT NULL,
    channels text[] DEFAULT '{}'::text[] NOT NULL,
    outcome_verdict text,
    outcome_note text,
    coverage_at_scoring jsonb,
    scored_at timestamp with time zone,
    scored_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT campaign_channels_nonempty_check CHECK ((cardinality(channels) > 0)),
    CONSTRAINT campaign_closed_is_scored_check CHECK (((status <> 'closed'::text) OR (scored_at IS NOT NULL))),
    CONSTRAINT campaign_scored_pair_check CHECK (((scored_at IS NULL) = (outcome_verdict IS NULL))),
    CONSTRAINT campaign_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'closed'::text]))),
    CONSTRAINT campaign_verdict_check CHECK (((outcome_verdict IS NULL) OR (outcome_verdict = ANY (ARRAY['worked'::text, 'did_not_work'::text, 'inconclusive'::text])))),
    CONSTRAINT campaign_window_check CHECK (((ends_on IS NULL) OR (ends_on >= starts_on)))
);

CREATE TABLE public.capture_candidate (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    batch_hash text NOT NULL,
    item_index integer NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    evidence_quote text NOT NULL,
    confidence numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by uuid,
    resolution_note text,
    resulting_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    applied_automatically boolean DEFAULT false NOT NULL,
    undone_at timestamp with time zone,
    undone_by uuid,
    CONSTRAINT capture_candidate_automatic_check CHECK (((NOT applied_automatically) OR (status = 'confirmed'::text))),
    CONSTRAINT capture_candidate_check CHECK ((((status = 'pending'::text) AND (resolved_by IS NULL) AND (resolved_at IS NULL) AND (resulting_ref IS NULL)) OR ((status = 'skipped'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resulting_ref IS NULL)) OR ((status = 'confirmed'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resulting_ref IS NOT NULL)))),
    CONSTRAINT capture_candidate_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT capture_candidate_evidence_quote_check CHECK ((array_length(regexp_split_to_array(btrim(evidence_quote), '\s+'::text), 1) <= 15)),
    CONSTRAINT capture_candidate_item_index_check CHECK ((item_index >= 0)),
    CONSTRAINT capture_candidate_kind_check CHECK ((kind = ANY (ARRAY['phase_move'::text, 'next_step'::text, 'new_deal'::text, 'activity'::text, 'meeting_record'::text]))),
    CONSTRAINT capture_candidate_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT capture_candidate_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'skipped'::text]))),
    CONSTRAINT capture_candidate_undo_check CHECK ((((undone_at IS NULL) = (undone_by IS NULL)) AND ((undone_at IS NULL) OR applied_automatically)))
);

CREATE TABLE public.capture_post_call_action (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    deal_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    due_on date,
    description text NOT NULL,
    accepted_by uuid NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    item_title text,
    item_bullets jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_ref text,
    organization_tenant_id text DEFAULT 'example-tenant'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT capture_post_call_action_check CHECK ((((status = 'done'::text) AND (completed_at IS NOT NULL)) OR ((status = ANY (ARRAY['open'::text, 'dropped'::text])) AND (completed_at IS NULL)))),
    CONSTRAINT capture_post_call_action_description_check CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT capture_post_call_action_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'dropped'::text]))),
    CONSTRAINT capture_post_call_item_shape CHECK (((item_title IS NULL) OR (((cardinality(regexp_split_to_array(btrim(item_title), '\s+'::text)) >= 2) AND (cardinality(regexp_split_to_array(btrim(item_title), '\s+'::text)) <= 4)) AND (source_ref IS NOT NULL) AND (btrim(source_ref) <> ''::text) AND (jsonb_typeof(item_bullets) = 'array'::text))))
);

CREATE TABLE public.capture_post_call_candidate (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    batch_hash text NOT NULL,
    item_index integer NOT NULL,
    kind text NOT NULL,
    deal_id uuid NOT NULL,
    assignee_slug text,
    action_description text,
    due_on date,
    recipient_party_id uuid,
    recipient_ref text,
    email_subject text,
    body_sha256 text,
    evidence_quote text NOT NULL,
    confidence numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by uuid,
    resolution_note text,
    resulting_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    contact_party_id uuid,
    due_defaulted boolean,
    CONSTRAINT capture_post_call_candidate_check CHECK ((((kind = 'assigned_action'::text) AND (assignee_slug = ANY (ARRAY['partner_one'::text, 'partner_two'::text])) AND (action_description IS NOT NULL) AND (btrim(action_description) <> ''::text) AND (recipient_party_id IS NULL) AND (recipient_ref IS NULL) AND (email_subject IS NULL) AND (body_sha256 IS NULL)) OR ((kind = 'email_draft'::text) AND (assignee_slug IS NULL) AND (action_description IS NULL) AND (due_on IS NULL) AND (recipient_party_id IS NOT NULL) AND (recipient_ref ~ '^P-[0-9]+$'::text) AND (email_subject IS NOT NULL) AND (btrim(email_subject) <> ''::text) AND (body_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT capture_post_call_candidate_check1 CHECK ((((status = 'pending'::text) AND (resolved_by IS NULL) AND (resolved_at IS NULL) AND (resulting_ref IS NULL)) OR ((status = 'skipped'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resulting_ref IS NULL)) OR ((status = 'confirmed'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL) AND ((resulting_ref IS NOT NULL) OR (kind = 'email_draft'::text))))),
    CONSTRAINT capture_post_call_candidate_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT capture_post_call_candidate_evidence_quote_check CHECK ((array_length(regexp_split_to_array(btrim(evidence_quote), '\s+'::text), 1) <= 15)),
    CONSTRAINT capture_post_call_candidate_item_index_check CHECK ((item_index >= 0)),
    CONSTRAINT capture_post_call_candidate_kind_check CHECK ((kind = ANY (ARRAY['assigned_action'::text, 'email_draft'::text]))),
    CONSTRAINT capture_post_call_candidate_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'skipped'::text])))
);

CREATE TABLE public.capture_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nonce text NOT NULL,
    device_id text NOT NULL,
    actor_id uuid NOT NULL,
    mode text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    consent_announced_at timestamp with time zone NOT NULL,
    session_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'recording'::text NOT NULL,
    state_at timestamp with time zone NOT NULL,
    state_detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    post_call boolean DEFAULT false NOT NULL,
    outcome_reviewed_at timestamp with time zone,
    outcome_reviewed_by uuid,
    CONSTRAINT capture_session_mode_check CHECK ((mode = 'meeting'::text)),
    CONSTRAINT capture_session_outcome_review_check CHECK (((outcome_reviewed_at IS NULL) = (outcome_reviewed_by IS NULL))),
    CONSTRAINT capture_session_state_check CHECK ((state = ANY (ARRAY['recording'::text, 'transcribing'::text, 'distilling'::text, 'done'::text, 'failed'::text])))
);

CREATE TABLE public.client (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    roster_ref text,
    party_id uuid NOT NULL,
    client_type text,
    vertical text,
    subtype text,
    status text,
    etl_status text,
    acquisition_source text,
    acquisition_detail text,
    notes_path text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    owner_id uuid,
    owner_label text,
    merged_into uuid,
    contact_label text,
    deal_type_label text,
    possible_duplicate_label text,
    notes text,
    specialty_type_label text,
    prospect_engagement_status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT client_prospect_engagement_status_check CHECK ((prospect_engagement_status = ANY (ARRAY['active'::text, 'inactive'::text])))
);

CREATE TABLE public.client_status (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer DEFAULT 100 NOT NULL,
    is_active_pipeline boolean DEFAULT false NOT NULL,
    note text
);

CREATE TABLE public.client_type (
    slug text NOT NULL,
    label text NOT NULL
);

CREATE TABLE public.code_subject (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    repo text NOT NULL,
    commit_sha text,
    label text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT code_subject_repo_shape CHECK (((repo = lower(btrim(repo))) AND (repo ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'::text))),
    CONSTRAINT code_subject_sha_shape CHECK (((commit_sha IS NULL) OR (commit_sha ~ '^[0-9a-f]{7,40}$'::text)))
);

CREATE TABLE public.commission (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    gross_amount numeric(14,2) NOT NULL,
    status text NOT NULL,
    invoiced_on date,
    received_on date,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    due_on date,
    CONSTRAINT commission_gross_amount_check CHECK ((gross_amount >= (0)::numeric)),
    CONSTRAINT commission_status_check CHECK ((status = ANY (ARRAY['expected'::text, 'invoiced'::text, 'received'::text])))
);

CREATE TABLE public.commission_allocation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    commission_id uuid NOT NULL,
    parent_id uuid,
    actor_id uuid,
    party_id uuid,
    kind text NOT NULL,
    fraction numeric(6,5) NOT NULL,
    computed_amount numeric(14,2),
    CONSTRAINT allocation_not_own_parent CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT commission_allocation_check CHECK (((actor_id IS NOT NULL) OR (party_id IS NOT NULL))),
    CONSTRAINT commission_allocation_fraction_check CHECK (((fraction > (0)::numeric) AND (fraction <= (1)::numeric))),
    CONSTRAINT commission_allocation_kind_check CHECK ((kind = ANY (ARRAY['referral_fee'::text, 'partner_split'::text, 'house'::text, 'other'::text])))
);

CREATE TABLE public.comp (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid,
    building_id uuid,
    executed_on date,
    term_months integer,
    rate_amount numeric(12,2) NOT NULL,
    rate_basis text NOT NULL,
    rate_norm_sf_yr numeric(12,2),
    ti_amount numeric(12,2),
    escalator text,
    is_estimate boolean DEFAULT false NOT NULL,
    source text NOT NULL,
    source_row jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT comp_rate_amount_check CHECK ((rate_amount > (0)::numeric)),
    CONSTRAINT comp_rate_basis_check CHECK ((rate_basis = ANY (ARRAY['usd_sf_yr'::text, 'usd_sf_mo'::text, 'usd_mo_gross'::text, 'usd_yr_gross'::text]))),
    CONSTRAINT comp_rate_norm_sf_yr_check CHECK (((rate_norm_sf_yr IS NULL) OR ((rate_norm_sf_yr >= (2)::numeric) AND (rate_norm_sf_yr <= (250)::numeric)))),
    CONSTRAINT comp_term_months_check CHECK (((term_months >= 1) AND (term_months <= 480)))
);

CREATE TABLE public.contact_state (
    slug text NOT NULL,
    label text NOT NULL,
    contactable boolean NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.critical_date (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    kind text NOT NULL,
    due_on date NOT NULL,
    note text,
    source text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT critical_date_status_check CHECK ((status = ANY (ARRAY['open'::text, 'passed'::text, 'cleared'::text, 'dropped'::text, 'done'::text])))
);

CREATE TABLE public.deal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    salesforce_id text,
    deal_type text NOT NULL,
    phase text NOT NULL,
    segment text,
    outcome text,
    closed_on date,
    won_value numeric(14,2),
    sf_commission_placeholder numeric(14,2),
    sf_close_date_placeholder date,
    notes_path text,
    source_row jsonb,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    lane text,
    city text,
    owner text,
    attention boolean DEFAULT false NOT NULL,
    next_date date,
    operating_state text DEFAULT 'active'::text NOT NULL,
    parking_reason text,
    parking_note text,
    parked_at timestamp with time zone,
    parked_by uuid,
    invoiced_on date,
    CONSTRAINT deal_operating_state_check CHECK ((operating_state = ANY (ARRAY['active'::text, 'parked'::text]))),
    CONSTRAINT deal_outcome_check CHECK ((outcome = ANY (ARRAY['won'::text, 'lost'::text, 'paused'::text]))),
    CONSTRAINT deal_parking_shape_check CHECK ((((operating_state = 'active'::text) AND (parking_reason IS NULL) AND (parking_note IS NULL) AND (parked_at IS NULL) AND (parked_by IS NULL)) OR ((operating_state = 'parked'::text) AND (parking_reason IS NOT NULL) AND (parking_reason = ANY (ARRAY['prospect_never_active'::text, 'client_paused'::text, 'other'::text])) AND (parked_at IS NOT NULL) AND (parked_by IS NOT NULL))))
);

CREATE TABLE public.deal_client_need (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    description text NOT NULL,
    applicability text NOT NULL,
    source_ref text NOT NULL,
    source_revision text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    fresh_until timestamp with time zone NOT NULL,
    restriction text NOT NULL,
    withdrawn boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    approved_revision integer,
    approved_client_id uuid,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT deal_client_need_applicability_check CHECK (((length(btrim(applicability)) >= 1) AND (length(btrim(applicability)) <= 2000))),
    CONSTRAINT deal_client_need_check CHECK ((fresh_until > observed_at)),
    CONSTRAINT deal_client_need_check1 CHECK ((((approved_revision IS NULL) AND (approved_client_id IS NULL) AND (approved_by IS NULL) AND (approved_at IS NULL)) OR ((approved_revision IS NOT NULL) AND (approved_revision = revision) AND (approved_client_id IS NOT NULL) AND (approved_by IS NOT NULL) AND (approved_at IS NOT NULL)))),
    CONSTRAINT deal_client_need_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 2000))),
    CONSTRAINT deal_client_need_restriction_check CHECK ((restriction = ANY (ARRAY['allowed'::text, 'restricted'::text]))),
    CONSTRAINT deal_client_need_revision_check CHECK ((revision > 0)),
    CONSTRAINT deal_client_need_source_ref_check CHECK (((length(btrim(source_ref)) >= 1) AND (length(btrim(source_ref)) <= 2000))),
    CONSTRAINT deal_client_need_source_revision_check CHECK (((length(btrim(source_revision)) >= 1) AND (length(btrim(source_revision)) <= 200))),
    CONSTRAINT deal_client_need_version_check CHECK ((version > 0))
);

CREATE TABLE public.deal_conflict (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    field text NOT NULL,
    value_a jsonb,
    actor_a uuid NOT NULL,
    event_a uuid NOT NULL,
    value_b jsonb,
    actor_b uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by uuid,
    winner text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT deal_conflict_check CHECK ((((status = 'open'::text) AND (resolved_by IS NULL) AND (winner IS NULL) AND (resolved_at IS NULL)) OR ((status = 'resolved'::text) AND (resolved_by IS NOT NULL) AND (winner IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT deal_conflict_field_check CHECK ((field = ANY (ARRAY['phase'::text, 'owner'::text, 'attention'::text, 'next_date'::text, 'operating_state'::text]))),
    CONSTRAINT deal_conflict_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
    CONSTRAINT deal_conflict_winner_check CHECK ((winner = ANY (ARRAY['a'::text, 'b'::text])))
);

CREATE TABLE public.deal_invoice_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    evidence_ref text NOT NULL,
    from_address text NOT NULL,
    deal_name text NOT NULL,
    client_name text,
    property_address text,
    occurred_at timestamp with time zone NOT NULL,
    email_date date NOT NULL,
    created_by uuid NOT NULL,
    status text DEFAULT 'captured'::text NOT NULL,
    deal_id uuid,
    prior_phase text,
    prior_invoiced_on date,
    phase_event_id uuid,
    invoice_event_id uuid,
    applied_at timestamp with time zone,
    applied_by uuid,
    reason text,
    undone_at timestamp with time zone,
    undone_by uuid,
    CONSTRAINT deal_invoice_email_check CHECK (((status = 'captured'::text) OR ((deal_id IS NOT NULL) AND (prior_phase IS NOT NULL) AND (phase_event_id IS NOT NULL) AND (invoice_event_id IS NOT NULL) AND (applied_at IS NOT NULL) AND (applied_by IS NOT NULL) AND (reason IS NOT NULL) AND (length(TRIM(BOTH FROM reason)) > 0)))),
    CONSTRAINT deal_invoice_email_check1 CHECK ((((status = 'undone'::text) = (undone_at IS NOT NULL)) AND ((undone_at IS NULL) = (undone_by IS NULL)))),
    CONSTRAINT deal_invoice_email_deal_name_check CHECK ((length(TRIM(BOTH FROM deal_name)) > 0)),
    CONSTRAINT deal_invoice_email_evidence_ref_check CHECK ((length(TRIM(BOTH FROM evidence_ref)) > 0)),
    CONSTRAINT deal_invoice_email_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'applied'::text, 'undone'::text])))
);

CREATE TABLE public.deal_lane (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer NOT NULL,
    note text
);

CREATE TABLE public.deal_market_assignment (
    deal_id uuid NOT NULL,
    agent_name text NOT NULL,
    agent_party_id uuid,
    market text,
    source text NOT NULL,
    set_by uuid NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_market_assignment_agent_name_check CHECK ((btrim(agent_name) <> ''::text))
);

CREATE TABLE public.deal_note (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    kind text NOT NULL,
    text text NOT NULL,
    actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_note_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'next_step'::text]))),
    CONSTRAINT deal_note_text_check CHECK ((btrim(text) <> ''::text))
);

CREATE TABLE public.deal_participant (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    actor_id uuid,
    party_id uuid,
    role text NOT NULL,
    from_at timestamp with time zone DEFAULT now() NOT NULL,
    to_at timestamp with time zone,
    set_by uuid NOT NULL,
    CONSTRAINT deal_participant_check CHECK (((actor_id IS NOT NULL) OR (party_id IS NOT NULL)))
);

CREATE TABLE public.deal_phase (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer DEFAULT 100 NOT NULL
);

CREATE TABLE public.deal_presence_lease (
    actor_id uuid NOT NULL,
    deal_id uuid NOT NULL,
    field text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.deal_reattach_log (
    deal_id uuid NOT NULL,
    from_client uuid NOT NULL,
    to_client uuid NOT NULL,
    from_segment text,
    reason text NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.deal_review_item (
    session_id uuid NOT NULL,
    deal_id uuid NOT NULL,
    disposition text NOT NULL,
    note text,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_review_item_disposition_check CHECK ((disposition = ANY (ARRAY['reviewed'::text, 'skipped'::text])))
);

CREATE TABLE public.deal_review_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_kind text NOT NULL,
    account_client_id uuid,
    started_by uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    summary text,
    CONSTRAINT deal_review_session_check CHECK ((((workspace_kind = 'team'::text) AND (account_client_id IS NULL)) OR ((workspace_kind = 'national_account'::text) AND (account_client_id IS NOT NULL)))),
    CONSTRAINT deal_review_session_check1 CHECK ((((status = 'open'::text) AND (ended_at IS NULL)) OR ((status <> 'open'::text) AND (ended_at IS NOT NULL)))),
    CONSTRAINT deal_review_session_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'abandoned'::text]))),
    CONSTRAINT deal_review_session_workspace_kind_check CHECK ((workspace_kind = ANY (ARRAY['team'::text, 'national_account'::text])))
);

CREATE TABLE public.deal_type_ref (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.deal_vendor_assignment (
    deal_id uuid NOT NULL,
    party_id uuid NOT NULL,
    role text NOT NULL,
    company_party_id uuid NOT NULL,
    contact_party_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    note text,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_vendor_assignment_role_check CHECK ((role = ANY (ARRAY['lender'::text, 'contractor'::text, 'architect'::text, 'attorney'::text, 'title'::text, 'inspector'::text, 'landlord_rep'::text])))
);

CREATE TABLE public.doc_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    source_path text NOT NULL,
    template_version text NOT NULL,
    field_map jsonb NOT NULL,
    output_kinds text[] DEFAULT '{working,pdf}'::text[] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL
);

CREATE TABLE public.doctrine_change_set (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid NOT NULL,
    session_key text,
    idempotency_key text NOT NULL,
    state text DEFAULT 'prepared'::text NOT NULL,
    gate_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT doctrine_change_set_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'committed'::text, 'rejected'::text])))
);

CREATE TABLE public.doctrine_edge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_section_id uuid NOT NULL,
    target_section_id uuid NOT NULL,
    edge_type text NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    introduced_by_revision_id uuid,
    retired_by_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.doctrine_edge_type (
    edge_type text NOT NULL,
    acyclic boolean NOT NULL,
    precedence_rank integer,
    description text NOT NULL
);

CREATE TABLE public.doctrine_gate_check (
    check_key text NOT NULL,
    description text NOT NULL,
    severity text NOT NULL,
    applies_to jsonb DEFAULT '{}'::jsonb NOT NULL,
    impl_key text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctrine_gate_check_severity_check CHECK ((severity = ANY (ARRAY['block'::text, 'warn'::text])))
);

CREATE TABLE public.doctrine_link (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_section_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    role text DEFAULT 'citation'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctrine_link_role_check CHECK ((role = ANY (ARRAY['citation'::text, 'related'::text, 'example'::text, 'source'::text]))),
    CONSTRAINT doctrine_link_target_kind_check CHECK ((target_kind = ANY (ARRAY['doctrine_document'::text, 'doctrine_section'::text, 'party'::text, 'deal'::text, 'decision'::text, 'rule'::text, 'loop'::text, 'capture'::text])))
);

CREATE TABLE public.doctrine_meta (
    id integer NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctrine_meta_id_check CHECK ((id = 1))
);

CREATE TABLE public.doctrine_review_policy (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    max_age_days integer,
    revalidate_on_dep_change boolean DEFAULT true NOT NULL,
    content_classes text[]
);

CREATE TABLE public.doctrine_revision (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    version bigint NOT NULL,
    parent_revision_id uuid,
    change_set_id uuid,
    actor_id uuid NOT NULL,
    session_key text,
    body jsonb NOT NULL,
    plain_text text NOT NULL,
    content_hash text NOT NULL,
    commit_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, plain_text)) STORED
);

CREATE TABLE public.doctrine_slug_alias (
    alias_slug text NOT NULL,
    document_id uuid NOT NULL,
    replaced_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.doctrine_snapshot (
    document_id uuid NOT NULL,
    generation bigint NOT NULL,
    snapshot_json jsonb NOT NULL,
    content_hash text NOT NULL,
    built_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.document (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    deal_id uuid,
    client_id uuid,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    prepared_by uuid NOT NULL,
    working_attachment uuid,
    pdf_attachment uuid,
    lint_passed boolean,
    leak_check_passed boolean,
    sent_status text DEFAULT 'draft'::text NOT NULL,
    note text,
    CONSTRAINT document_sent_status_check CHECK ((sent_status = ANY (ARRAY['draft'::text, 'handed_to_partner_one'::text, 'sent'::text])))
);

CREATE TABLE public.email_proposal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    deal_id uuid,
    activity_id uuid NOT NULL,
    evidence_quote text NOT NULL,
    task_text text,
    next_date date,
    owner text,
    confidence numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_reason text,
    draft_subject text,
    draft_body text,
    submitted_email jsonb,
    submitted_at timestamp with time zone,
    send_result jsonb,
    sender_role text,
    result_recorded_at timestamp with time zone,
    match_evidence jsonb,
    disposition text,
    resolution_note text,
    deferred_until timestamp with time zone,
    correction_provenance jsonb,
    CONSTRAINT email_proposal_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT email_proposal_disposition_check CHECK ((disposition = ANY (ARRAY['filed'::text, 'handled'::text, 'deferred'::text]))),
    CONSTRAINT email_proposal_evidence_quote_check CHECK (((length(evidence_quote) >= 1) AND (length(evidence_quote) <= 2000))),
    CONSTRAINT email_proposal_kind_check CHECK ((kind = ANY (ARRAY['phase_move'::text, 'next_step'::text, 'reply_draft'::text, 'file_to_deal'::text, 'possible_new_deal'::text]))),
    CONSTRAINT email_proposal_owner_check CHECK ((owner = ANY (ARRAY['partner_one'::text, 'partner_two'::text]))),
    CONSTRAINT email_proposal_resolution CHECK ((((status = 'pending'::text) AND (resolved_by IS NULL) AND (resolved_at IS NULL) AND (resolution_reason IS NULL)) OR ((status = 'confirmed'::text) AND ((kind <> 'reply_draft'::text) OR (NOT (disposition IS DISTINCT FROM 'handled'::text))) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL)) OR ((status = 'dismissed'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resolution_reason IS NOT NULL)) OR ((status = ANY (ARRAY['approved_to_send'::text, 'sent'::text, 'failed'::text])) AND (kind = 'reply_draft'::text) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT email_proposal_resolution_note_check CHECK ((length(resolution_note) <= 2000)),
    CONSTRAINT email_proposal_resolution_reason_check CHECK (((length(btrim(resolution_reason)) >= 1) AND (length(btrim(resolution_reason)) <= 500))),
    CONSTRAINT email_proposal_send_result CHECK (((((status <> ALL (ARRAY['sent'::text, 'failed'::text])) AND (send_result IS NULL)) OR ((status = ANY (ARRAY['sent'::text, 'failed'::text])) AND ((send_result ->> 'status'::text) = status))) IS TRUE)),
    CONSTRAINT email_proposal_sender_role_check CHECK ((sender_role = ANY (ARRAY['client'::text, 'landlord_side'::text, 'lender'::text, 'attorney'::text, 'other_vendor'::text]))),
    CONSTRAINT email_proposal_shape CHECK ((((kind = 'phase_move'::text) AND (deal_id IS NOT NULL) AND (task_text IS NULL) AND (next_date IS NULL) AND (owner IS NULL) AND (sender_role IS NULL)) OR ((kind = 'next_step'::text) AND (task_text IS NOT NULL) AND (next_date IS NOT NULL) AND (owner IS NOT NULL) AND (sender_role IS NULL)) OR ((kind = 'reply_draft'::text) AND (task_text IS NULL) AND (next_date IS NULL) AND (owner IS NOT NULL) AND ((length(draft_subject) >= 1) AND (length(draft_subject) <= 998)) AND ((length(btrim(draft_body)) >= 1) AND (length(btrim(draft_body)) <= 20000)) AND (sender_role IS NULL)) OR ((kind = 'file_to_deal'::text) AND (deal_id IS NOT NULL) AND (task_text IS NULL) AND (next_date IS NULL) AND (owner IS NULL) AND (sender_role IS NOT NULL) AND (draft_subject IS NULL) AND (draft_body IS NULL)) OR ((kind = 'possible_new_deal'::text) AND (deal_id IS NULL) AND (next_date IS NULL) AND (owner IS NULL) AND (sender_role IS NOT NULL) AND (draft_subject IS NULL) AND (draft_body IS NULL)))),
    CONSTRAINT email_proposal_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'dismissed'::text, 'approved_to_send'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT email_proposal_submission CHECK (((((submitted_email IS NULL) AND (submitted_at IS NULL) AND (status <> ALL (ARRAY['approved_to_send'::text, 'sent'::text, 'failed'::text]))) OR ((kind = 'reply_draft'::text) AND (submitted_at IS NOT NULL) AND (status = ANY (ARRAY['approved_to_send'::text, 'sent'::text, 'failed'::text])) AND (jsonb_typeof(submitted_email) = 'object'::text) AND (submitted_email ?& ARRAY['subject'::text, 'body'::text, 'sha256'::text, 'to'::text, 'cc'::text]))) IS TRUE)),
    CONSTRAINT email_proposal_task_text_check CHECK (((length(btrim(task_text)) >= 1) AND (length(btrim(task_text)) <= 500)))
);

CREATE TABLE public.event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid NOT NULL,
    verb text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    field text,
    old_value jsonb,
    new_value jsonb,
    cause text NOT NULL,
    human_quote text,
    agent_rationale text,
    idempotency_key text,
    via text,
    client_id text,
    sponsoring_human_slug text,
    personal_scope text,
    authorization_class text,
    organization_tenant_id text,
    correlation_id uuid,
    mutation_order bigint NOT NULL,
    CONSTRAINT event_cause_check CHECK ((cause = ANY (ARRAY['human_stated'::text, 'human_correction'::text, 'ingest_email'::text, 'ingest_calendar'::text, 'ingest_webhook'::text, 'import_migration'::text, 'import_salesforce'::text, 'automation_job'::text, 'learning_job'::text, 'system'::text]))),
    CONSTRAINT event_personal_scope_check CHECK (((personal_scope IS NULL) OR (personal_scope = ANY (ARRAY['partner_one-personal'::text, 'partner_two-personal'::text, 'none'::text])))),
    CONSTRAINT event_sponsoring_human_slug_check CHECK (((sponsoring_human_slug IS NULL) OR (sponsoring_human_slug = ANY (ARRAY['partner_one'::text, 'partner_two'::text]))))
);

ALTER TABLE public.event ALTER COLUMN mutation_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.event_mutation_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.ingest_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    external_id text,
    payload jsonb NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    filed_refs jsonb,
    triage_note text,
    CONSTRAINT ingest_inbox_status_check CHECK ((status = ANY (ARRAY['new'::text, 'triaged'::text, 'filed'::text, 'rejected'::text, 'duplicate'::text])))
);

CREATE TABLE public.lead (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registry_ref text,
    party_id uuid NOT NULL,
    lane text,
    stage text NOT NULL,
    score numeric(5,2),
    source_type text,
    suppressed boolean DEFAULT false NOT NULL,
    est_lease_event date,
    last_touch date,
    next_action_date date,
    client_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    source_detail text,
    segment text,
    report_back_due date,
    drip_campaign text,
    drip_added date,
    sf_deal text,
    notes_path text,
    notes text,
    event_source text,
    event_confidence text,
    owner_id uuid,
    owner_label text,
    est_lease_event_raw text,
    report_back_due_raw text,
    drip_added_raw text,
    score_reason text,
    CONSTRAINT lead_do_not_contact_suppressed CHECK (((stage <> 'do_not_contact'::text) OR suppressed)),
    CONSTRAINT lead_score_integer_range CHECK (((score IS NULL) OR (((score >= (0)::numeric) AND (score <= (100)::numeric)) AND (score = trunc(score)))))
);

CREATE TABLE public.lead_contact_draft (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    party_id uuid NOT NULL,
    owner_id uuid,
    subject text NOT NULL,
    body text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    time_zone text NOT NULL,
    requires_human_send boolean DEFAULT true NOT NULL,
    dispatchable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    approved_at timestamp with time zone,
    approved_by uuid,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT lead_contact_draft_check CHECK (((approved_at IS NULL) = (approved_by IS NULL))),
    CONSTRAINT lead_contact_draft_dispatchable_check CHECK ((NOT dispatchable)),
    CONSTRAINT lead_contact_draft_requires_human_send_check CHECK (requires_human_send),
    CONSTRAINT lead_contact_draft_revision_check CHECK ((revision >= 1))
);

CREATE TABLE public.lead_lane (
    slug text NOT NULL,
    label text NOT NULL
);

CREATE TABLE public.lead_stage (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer DEFAULT 100 NOT NULL
);

CREATE TABLE public.lead_stage_move (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    from_stage text NOT NULL,
    to_stage text NOT NULL,
    activity_id uuid NOT NULL,
    evidence_ref text NOT NULL,
    strength text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    approved_at timestamp with time zone,
    approved_by uuid,
    reason text NOT NULL,
    undone_at timestamp with time zone,
    undone_by uuid,
    CONSTRAINT archive_partner_required CHECK (((to_stage <> 'archived'::text) OR (status = 'proposed'::text) OR ((approved_at IS NOT NULL) AND (approved_by IS NOT NULL)))),
    CONSTRAINT lead_move_reason_nonempty CHECK ((length(TRIM(BOTH FROM reason)) > 0)),
    CONSTRAINT lead_move_undo_actor CHECK ((((status = 'undone'::text) = (undone_at IS NOT NULL)) AND ((undone_at IS NULL) = (undone_by IS NULL)))),
    CONSTRAINT lead_stage_move_check CHECK ((((from_stage = 'new'::text) AND (to_stage = 'qualified'::text)) OR ((from_stage = 'qualified'::text) AND (to_stage = 'outreach_active'::text)) OR ((from_stage = 'outreach_active'::text) AND (to_stage = 'engaged'::text)) OR ((from_stage = 'engaged'::text) AND (to_stage = ANY (ARRAY['nurture_drip'::text, 'opportunity'::text]))) OR ((from_stage = ANY (ARRAY['new'::text, 'qualified'::text, 'outreach_active'::text, 'engaged'::text, 'nurture_drip'::text, 'opportunity'::text])) AND (to_stage = 'archived'::text)))),
    CONSTRAINT lead_stage_move_check1 CHECK (((status = 'proposed'::text) OR (strength = 'strong'::text) OR ((approved_at IS NOT NULL) AND (approved_by IS NOT NULL)))),
    CONSTRAINT lead_stage_move_evidence_ref_check CHECK ((length(evidence_ref) > 0)),
    CONSTRAINT lead_stage_move_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'applied'::text, 'undone'::text]))),
    CONSTRAINT lead_stage_move_strength_check CHECK ((strength = ANY (ARRAY['strong'::text, 'weak'::text])))
);

CREATE TABLE public.lease (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid,
    client_id uuid,
    premises_id uuid,
    executed_on date,
    commencement_on date,
    expiration_on date,
    term_months integer,
    rate_amount numeric(12,2),
    rate_basis text,
    rate_norm_sf_yr numeric(12,2) GENERATED ALWAYS AS (
CASE rate_basis
    WHEN 'usd_sf_yr'::text THEN rate_amount
    WHEN 'usd_sf_mo'::text THEN (rate_amount * (12)::numeric)
    ELSE NULL::numeric
END) STORED,
    escalator text,
    ti_amount numeric(12,2),
    free_rent_months numeric(4,1),
    options_note text,
    opex_structure text,
    doc_attachment uuid,
    source text DEFAULT 'stated'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    owner_id uuid,
    evidence_kind text,
    evidence_ref text,
    status text DEFAULT 'legacy_unverified'::text NOT NULL,
    superseded_at timestamp with time zone,
    supersedes_lease_id uuid,
    CONSTRAINT lease_check CHECK (((rate_amount IS NULL) OR (rate_basis IS NOT NULL))),
    CONSTRAINT lease_evidence_kind_check CHECK (((evidence_kind IS NULL) OR (evidence_kind = ANY (ARRAY['executed_lease'::text, 'lease_amendment'::text, 'lease_abstract'::text])))),
    CONSTRAINT lease_rate_amount_check CHECK ((rate_amount > (0)::numeric)),
    CONSTRAINT lease_rate_basis_check CHECK ((rate_basis = ANY (ARRAY['usd_sf_yr'::text, 'usd_sf_mo'::text, 'usd_mo_gross'::text, 'usd_yr_gross'::text]))),
    CONSTRAINT lease_status_check CHECK ((status = ANY (ARRAY['legacy_unverified'::text, 'current'::text, 'superseded'::text]))),
    CONSTRAINT lease_term_months_check CHECK (((term_months >= 1) AND (term_months <= 480)))
);

CREATE TABLE public.loop_domain (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.marketing_subject (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    slug text NOT NULL,
    label text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    retired_at timestamp with time zone,
    CONSTRAINT marketing_subject_slug_check CHECK (((slug = lower(btrim(slug))) AND (slug <> ''::text) AND (slug !~ '\s'::text))),
    CONSTRAINT marketing_subject_subject_type_check CHECK ((subject_type = ANY (ARRAY['platform'::text, 'pillar'::text, 'format'::text])))
);

CREATE TABLE public.national_account_owner (
    account_client_id uuid NOT NULL,
    owner_actor_id uuid NOT NULL,
    set_by uuid NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.negotiation_claim (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    round_id uuid NOT NULL,
    claim_type text NOT NULL,
    loggable boolean DEFAULT false NOT NULL,
    stated_floor numeric(12,2),
    stated_floor_basis text,
    quote text,
    note text,
    source text DEFAULT 'stated'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT negotiation_claim_check CHECK (((stated_floor IS NULL) OR (stated_floor_basis IS NOT NULL))),
    CONSTRAINT negotiation_claim_loggable_check CHECK ((loggable IS FALSE)),
    CONSTRAINT negotiation_claim_stated_floor_basis_check CHECK (((stated_floor_basis IS NULL) OR (stated_floor_basis = ANY (ARRAY['usd_sf_yr'::text, 'usd_sf_mo'::text, 'usd_mo_gross'::text, 'usd_yr_gross'::text, 'usd_total'::text, 'usd_sf_total'::text])))),
    CONSTRAINT negotiation_claim_stated_floor_check CHECK (((stated_floor IS NULL) OR (stated_floor > (0)::numeric)))
);

CREATE TABLE public.negotiation_claim_type (
    slug text NOT NULL,
    label text NOT NULL,
    falsifiable boolean NOT NULL,
    derived boolean DEFAULT false NOT NULL,
    reversal_test text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.negotiation_round (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    round_no integer NOT NULL,
    side text NOT NULL,
    proposed_on date NOT NULL,
    rate_amount numeric(12,2),
    rate_basis text,
    rate_norm_sf_yr numeric(12,2) GENERATED ALWAYS AS (
CASE rate_basis
    WHEN 'usd_sf_yr'::text THEN rate_amount
    WHEN 'usd_sf_mo'::text THEN (rate_amount * (12)::numeric)
    ELSE NULL::numeric
END) STORED,
    ti_amount numeric(12,2),
    ti_basis text,
    free_rent_months numeric(4,1),
    term_months integer,
    options_note text,
    escalator text,
    opex_note text,
    expires_on date,
    note text,
    source text DEFAULT 'stated'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    submarket_condition text,
    CONSTRAINT negotiation_round_check CHECK (((rate_amount IS NULL) OR (rate_basis IS NOT NULL))),
    CONSTRAINT negotiation_round_free_rent_months_check CHECK (((free_rent_months >= (0)::numeric) AND (free_rent_months <= (36)::numeric))),
    CONSTRAINT negotiation_round_rate_amount_check CHECK ((rate_amount > (0)::numeric)),
    CONSTRAINT negotiation_round_rate_basis_check CHECK ((rate_basis = ANY (ARRAY['usd_sf_yr'::text, 'usd_sf_mo'::text, 'usd_mo_gross'::text, 'usd_yr_gross'::text, 'usd_total'::text, 'usd_sf_total'::text]))),
    CONSTRAINT negotiation_round_round_no_check CHECK (((round_no >= 1) AND (round_no <= 99))),
    CONSTRAINT negotiation_round_side_check CHECK ((side = ANY (ARRAY['tenant'::text, 'landlord'::text, 'buyer'::text, 'seller'::text]))),
    CONSTRAINT negotiation_round_term_months_check CHECK (((term_months >= 1) AND (term_months <= 480))),
    CONSTRAINT negotiation_round_ti_basis_check CHECK ((ti_basis = ANY (ARRAY['usd_total'::text, 'usd_sf'::text])))
);

CREATE TABLE public.next_action (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    due_on date,
    description text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    hold_until date,
    item_title text,
    item_bullets jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_ref text,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    organization_tenant_id text DEFAULT 'example-tenant'::text NOT NULL,
    CONSTRAINT next_action_item_shape CHECK (((item_title IS NULL) OR ((subject_type = 'deal'::text) AND ((cardinality(regexp_split_to_array(btrim(item_title), '\s+'::text)) >= 2) AND (cardinality(regexp_split_to_array(btrim(item_title), '\s+'::text)) <= 4)) AND (source_ref IS NOT NULL) AND (btrim(source_ref) <> ''::text) AND (jsonb_typeof(item_bullets) = 'array'::text)))),
    CONSTRAINT next_action_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'dropped'::text, 'expired'::text]))),
    CONSTRAINT next_action_subject_type_check CHECK ((subject_type = ANY (ARRAY['deal'::text, 'client'::text, 'lead'::text, 'vendor'::text])))
);

CREATE TABLE public.parcel (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    county text NOT NULL,
    state text NOT NULL,
    parcel_no text NOT NULL,
    source text NOT NULL
);

CREATE TABLE public.participant_role (
    slug text NOT NULL,
    label text NOT NULL,
    side text,
    CONSTRAINT participant_role_side_check CHECK ((side = ANY (ARRAY['actor'::text, 'party'::text])))
);

CREATE TABLE public.partner_room_turn (
    id bigint NOT NULL,
    room_id text DEFAULT 'partner-line'::text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    sponsor text NOT NULL,
    seat text NOT NULL,
    kind text DEFAULT 'turn'::text NOT NULL,
    body text NOT NULL,
    msg_id uuid NOT NULL,
    origin_channel text DEFAULT 'legacy'::text NOT NULL,
    origin_actor text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT partner_room_turn_body_bounds CHECK (((btrim(body) <> ''::text) AND (length(body) <= 20000))),
    CONSTRAINT partner_room_turn_kind_known CHECK ((kind = ANY (ARRAY['turn'::text, 'system'::text, 'receipt'::text]))),
    CONSTRAINT partner_room_turn_origin_actor_slug CHECK ((origin_actor ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT partner_room_turn_origin_channel_known CHECK ((origin_channel = ANY (ARRAY['legacy'::text, 'mcp'::text, 'browser-human'::text]))),
    CONSTRAINT partner_room_turn_room_slug CHECK ((room_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT partner_room_turn_seat_slug CHECK ((seat ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT partner_room_turn_sponsor_known CHECK ((sponsor = ANY (ARRAY['partner_one'::text, 'partner_two'::text])))
);

ALTER TABLE public.partner_room_turn ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.partner_room_turn_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.party (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    org_id uuid,
    phone text,
    email text,
    city text,
    state text,
    npi text,
    notes_path text,
    merged_into uuid,
    deleted_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    specialty text,
    county text,
    title text,
    ref text,
    contact_state text DEFAULT 'active'::text NOT NULL,
    contact_state_reason text,
    contact_state_until date,
    contact_state_cadence text,
    contact_state_set_by uuid,
    contact_state_set_at timestamp with time zone,
    cell text,
    vendor_assignment_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT party_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'org'::text])))
);

CREATE TABLE public.party_link (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_party uuid NOT NULL,
    to_party uuid NOT NULL,
    kind text NOT NULL,
    note text,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    via_party uuid,
    occurred_on date,
    CONSTRAINT party_link_check CHECK ((from_party <> to_party))
);

CREATE TABLE public.party_link_deal (
    link_id uuid NOT NULL,
    deal_id uuid NOT NULL,
    referred_by uuid NOT NULL,
    occurred_on date,
    note text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT party_link_deal_note_check CHECK ((length(TRIM(BOTH FROM note)) > 0))
);

CREATE TABLE public.party_link_kind (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.premises (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL
);

CREATE TABLE public.premises_space (
    premises_id uuid NOT NULL,
    space_id uuid NOT NULL
);

CREATE TABLE public.record_flag (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    kind text NOT NULL,
    value jsonb NOT NULL,
    source text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_on date,
    created_by uuid NOT NULL,
    CONSTRAINT record_flag_subject_type_check CHECK ((subject_type = ANY (ARRAY['lead'::text, 'client'::text, 'vendor'::text, 'party'::text, 'deal'::text, 'campaign'::text, 'platform'::text, 'pillar'::text, 'format'::text, 'repo'::text, 'commit'::text])))
);

CREATE TABLE public.record_source (
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    source_system text NOT NULL,
    external_key text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.ref_client_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.ref_lead_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.ref_vendor_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.registration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deal_id uuid NOT NULL,
    premises_id uuid,
    registered_with_party uuid NOT NULL,
    registered_on date NOT NULL,
    method text,
    doc_attachment uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL
);

CREATE TABLE public.room_dispatch_link (
    id bigint NOT NULL,
    turn_id bigint NOT NULL,
    session_id text NOT NULL,
    work_request_id uuid,
    dispatch_ref uuid NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    written_by text NOT NULL
);

CREATE SEQUENCE public.room_dispatch_link_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.room_dispatch_link_id_seq OWNED BY public.room_dispatch_link.id;

CREATE TABLE public.signal_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    producer text NOT NULL,
    signal_key text NOT NULL,
    signal_kind text NOT NULL,
    subject_type text NOT NULL,
    subject_ref text NOT NULL,
    metric_name text NOT NULL,
    observed_value numeric NOT NULL,
    baseline_value numeric,
    threshold_value numeric NOT NULL,
    comparison text NOT NULL,
    severity text NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    evidence_refs jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT signal_event_comparison_check CHECK ((comparison = ANY (ARRAY['gt'::text, 'gte'::text, 'lt'::text, 'lte'::text, 'delta_abs_gte'::text]))),
    CONSTRAINT signal_event_evidence_refs_check CHECK (((jsonb_typeof(evidence_refs) = 'array'::text) AND (jsonb_array_length(evidence_refs) > 0))),
    CONSTRAINT signal_event_metric_name_check CHECK ((btrim(metric_name) <> ''::text)),
    CONSTRAINT signal_event_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT signal_event_producer_check CHECK ((btrim(producer) <> ''::text)),
    CONSTRAINT signal_event_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT signal_event_signal_key_check CHECK ((btrim(signal_key) <> ''::text)),
    CONSTRAINT signal_event_signal_kind_check CHECK ((btrim(signal_kind) <> ''::text)),
    CONSTRAINT signal_event_status_check CHECK ((status = ANY (ARRAY['open'::text, 'claimed'::text, 'resolved'::text, 'dismissed'::text]))),
    CONSTRAINT signal_event_subject_ref_check CHECK ((btrim(subject_ref) <> ''::text)),
    CONSTRAINT signal_event_subject_type_check CHECK ((btrim(subject_type) <> ''::text))
);

CREATE TABLE public.space (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    building_id uuid NOT NULL,
    suite text,
    floor integer,
    area_amount numeric(10,1),
    area_basis text,
    condition text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT space_area_amount_check CHECK (((area_amount >= (50)::numeric) AND (area_amount <= (500000)::numeric))),
    CONSTRAINT space_area_basis_check CHECK ((area_basis = ANY (ARRAY['rentable'::text, 'usable'::text, 'county_heated'::text, 'listed_unverified'::text])))
);

CREATE TABLE public.space_search (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    deal_id uuid,
    spec jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    report_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT space_search_status_check CHECK ((status = ANY (ARRAY['open'::text, 'delivered'::text, 'closed'::text])))
);

CREATE TABLE public.submarket_condition (
    slug text NOT NULL,
    label text NOT NULL,
    tightness smallint NOT NULL,
    note text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.system_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE public.tool_call (
    idempotency_key text NOT NULL,
    verb text NOT NULL,
    actor_id uuid NOT NULL,
    request_hash text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    via text,
    client_id text,
    sponsoring_human_slug text,
    personal_scope text,
    authorization_class text,
    organization_tenant_id text,
    correlation_id uuid,
    CONSTRAINT tool_call_personal_scope_check CHECK (((personal_scope IS NULL) OR (personal_scope = ANY (ARRAY['partner_one-personal'::text, 'partner_two-personal'::text, 'none'::text])))),
    CONSTRAINT tool_call_sponsoring_human_slug_check CHECK (((sponsoring_human_slug IS NULL) OR (sponsoring_human_slug = ANY (ARRAY['partner_one'::text, 'partner_two'::text]))))
);

CREATE VIEW public.v_last_touch AS
 WITH contact AS (
         SELECT a.id,
            a.occurred_at,
            a.recorded_at,
            a.actor_id,
            a.kind,
            a.summary,
            a.detail,
            a.owed,
            a.deal_id,
            a.client_id,
            a.lead_id,
            a.vendor_id,
            a.source,
            a.version,
            a.updated_at,
            a.updated_by,
            a.connected
           FROM (public.activity a
             JOIN public.activity_kind k ON ((k.slug = a.kind)))
          WHERE (k.is_contact OR ((a.kind = 'note'::text) AND (a.summary = 'last-touch stamp (imported)'::text)) OR ((a.kind = 'note'::text) AND (a.summary ~~ 'Last touch carried from%'::text)))
        ), deal_contact AS (
         SELECT d.id AS deal_id,
            c.occurred_at
           FROM (public.deal d
             JOIN contact c ON ((c.deal_id = d.id)))
        UNION ALL
         SELECT d.id,
            c.occurred_at
           FROM ((public.deal d
             JOIN public.client cl ON ((cl.id = d.client_id)))
             JOIN contact c ON ((c.client_id = cl.id)))
        )
 SELECT 'deal'::text AS subject_type,
    deal_contact.deal_id AS subject_id,
    public.carr_business_date(max(deal_contact.occurred_at)) AS last_touch
   FROM deal_contact
  GROUP BY deal_contact.deal_id
UNION ALL
 SELECT 'client'::text AS subject_type,
    contact.client_id AS subject_id,
    public.carr_business_date(max(contact.occurred_at)) AS last_touch
   FROM contact
  WHERE (contact.client_id IS NOT NULL)
  GROUP BY contact.client_id
UNION ALL
 SELECT 'lead'::text AS subject_type,
    contact.lead_id AS subject_id,
    public.carr_business_date(max(contact.occurred_at)) AS last_touch
   FROM contact
  WHERE (contact.lead_id IS NOT NULL)
  GROUP BY contact.lead_id
UNION ALL
 SELECT 'vendor'::text AS subject_type,
    contact.vendor_id AS subject_id,
    public.carr_business_date(max(contact.occurred_at)) AS last_touch
   FROM contact
  WHERE (contact.vendor_id IS NOT NULL)
  GROUP BY contact.vendor_id;

CREATE TABLE public.vendor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_ref text,
    party_id uuid NOT NULL,
    category text NOT NULL,
    verticals text[],
    stage text,
    owner_id uuid,
    referral_active boolean,
    territory text,
    offers text,
    seeking text,
    rivalry_group text,
    originated text,
    enrich boolean,
    out_of_market boolean DEFAULT false NOT NULL,
    last_touch date,
    intro_notes text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    owner_label text,
    links_label text,
    relationship_level integer,
    disposition text DEFAULT 'active'::text NOT NULL,
    is_target boolean DEFAULT false NOT NULL,
    category_slug text,
    merged_into uuid,
    loan_programs text[],
    deal_history_verified_at timestamp with time zone,
    trust_override jsonb,
    deal_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT vendor_deal_evidence_array CHECK ((jsonb_typeof(deal_evidence) = 'array'::text)),
    CONSTRAINT vendor_trust_override_shape CHECK (((trust_override IS NULL) OR ((jsonb_typeof(trust_override) = 'object'::text) AND (trust_override ?& ARRAY['tier'::text, 'recorded_by'::text, 'reason'::text, 'recorded_at'::text]) AND (jsonb_typeof((trust_override -> 'reason'::text)) = 'string'::text) AND ((trust_override ->> 'tier'::text) = ANY (ARRAY['Proven'::text, 'Established'::text, 'Trial'::text])) AND ((trust_override ->> 'recorded_by'::text) = ANY (ARRAY['partner_one'::text, 'partner_two'::text])) AND ((length(TRIM(BOTH FROM (trust_override ->> 'reason'::text))) >= 1) AND (length(TRIM(BOTH FROM (trust_override ->> 'reason'::text))) <= 500)) AND ((trust_override ->> 'recorded_at'::text) IS NOT NULL))))
);

CREATE VIEW public.v_ref_index AS
 SELECT 'lead'::text AS subject_type,
    l.id AS subject_id,
    l.registry_ref AS ref,
    p.name AS display_name,
    org.name AS org_name,
    p.city,
    p.specialty,
    l.stage AS status,
    (p.merged_into IS NOT NULL) AS merged,
    NULL::text AS client_ref,
    p.id AS party_id
   FROM ((public.lead l
     JOIN public.party p ON ((p.id = l.party_id)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
UNION ALL
 SELECT 'client'::text AS subject_type,
    c.id AS subject_id,
    c.roster_ref AS ref,
    p.name AS display_name,
    org.name AS org_name,
    p.city,
    p.specialty,
    c.status,
    (COALESCE(c.merged_into, p.merged_into) IS NOT NULL) AS merged,
    NULL::text AS client_ref,
    p.id AS party_id
   FROM ((public.client c
     JOIN public.party p ON ((p.id = c.party_id)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
UNION ALL
 SELECT 'vendor'::text AS subject_type,
    v.id AS subject_id,
    v.vendor_ref AS ref,
    p.name AS display_name,
    org.name AS org_name,
    p.city,
    p.specialty,
    v.stage AS status,
    ((p.merged_into IS NOT NULL) OR (v.merged_into IS NOT NULL)) AS merged,
    NULL::text AS client_ref,
    p.id AS party_id
   FROM ((public.vendor v
     JOIN public.party p ON ((p.id = v.party_id)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
UNION ALL
 SELECT 'deal'::text AS subject_type,
    d.id AS subject_id,
    NULL::text AS ref,
    d.name AS display_name,
    NULL::text AS org_name,
    NULL::text AS city,
    NULL::text AS specialty,
    d.phase AS status,
    false AS merged,
    c.roster_ref AS client_ref,
    NULL::uuid AS party_id
   FROM (public.deal d
     LEFT JOIN public.client c ON ((c.id = d.client_id)))
UNION ALL
 SELECT 'party'::text AS subject_type,
    p.id AS subject_id,
    p.ref,
    p.name AS display_name,
    org.name AS org_name,
    p.city,
    p.specialty,
    p.contact_state AS status,
    (p.merged_into IS NOT NULL) AS merged,
    NULL::text AS client_ref,
    p.id AS party_id
   FROM (public.party p
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
  WHERE ((p.deleted_at IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.lead l
          WHERE (l.party_id = p.id)))) AND (NOT (EXISTS ( SELECT 1
           FROM public.client c
          WHERE (c.party_id = p.id)))) AND (NOT (EXISTS ( SELECT 1
           FROM public.vendor v
          WHERE (v.party_id = p.id)))));

CREATE VIEW public.v_record_flag_subject AS
 SELECT f.id AS flag_id,
    f.subject_type,
    f.subject_id,
        CASE f.subject_type
            WHEN 'campaign'::text THEN ( SELECT c.name
               FROM public.campaign c
              WHERE (c.id = f.subject_id))
            WHEN 'platform'::text THEN ( SELECT m.label
               FROM public.marketing_subject m
              WHERE (m.id = f.subject_id))
            WHEN 'pillar'::text THEN ( SELECT m.label
               FROM public.marketing_subject m
              WHERE (m.id = f.subject_id))
            WHEN 'format'::text THEN ( SELECT m.label
               FROM public.marketing_subject m
              WHERE (m.id = f.subject_id))
            WHEN 'repo'::text THEN ( SELECT COALESCE(k.label, k.repo) AS "coalesce"
               FROM public.code_subject k
              WHERE (k.id = f.subject_id))
            WHEN 'commit'::text THEN ( SELECT COALESCE(k.label, ((k.repo || '@'::text) || "left"(k.commit_sha, 7))) AS "coalesce"
               FROM public.code_subject k
              WHERE (k.id = f.subject_id))
            ELSE ( SELECT r.display_name
               FROM public.v_ref_index r
              WHERE ((r.subject_type = f.subject_type) AND (r.subject_id = f.subject_id))
             LIMIT 1)
        END AS subject_label,
        CASE
            WHEN (f.subject_type = ANY (ARRAY['campaign'::text, 'platform'::text, 'pillar'::text, 'format'::text])) THEN NULL::text
            WHEN (f.subject_type = 'repo'::text) THEN ( SELECT k.repo
               FROM public.code_subject k
              WHERE (k.id = f.subject_id))
            WHEN (f.subject_type = 'commit'::text) THEN ( SELECT ((k.repo || '@'::text) || k.commit_sha)
               FROM public.code_subject k
              WHERE (k.id = f.subject_id))
            ELSE ( SELECT r.ref
               FROM public.v_ref_index r
              WHERE ((r.subject_type = f.subject_type) AND (r.subject_id = f.subject_id))
             LIMIT 1)
        END AS subject_ref,
    f.kind,
    COALESCE(((f.value ->> 'found'::text))::boolean, true) AS found,
    (f.value ? 'proposes_correction'::text) AS proposes_correction,
    f.value,
    f.source,
    f.observed_at,
    f.expires_on,
    ((f.expires_on IS NOT NULL) AND (f.expires_on < CURRENT_DATE)) AS expired,
    a.slug AS recorded_by
   FROM (public.record_flag f
     LEFT JOIN public.actor a ON ((a.id = f.created_by)));

CREATE VIEW public.v_capture_candidate_queue AS
 SELECT c.id,
    c.session_id,
    c.kind,
    c.payload,
    c.evidence_quote,
    c.confidence,
    c.created_at,
    COALESCE(direct_deal.name, named_deal.name) AS deal_name
   FROM (((public.capture_candidate c
     JOIN public.capture_session s ON ((s.id = c.session_id)))
     LEFT JOIN public.deal direct_deal ON (((direct_deal.id)::text = COALESCE((c.payload ->> 'deal'::text), (c.payload ->> 'ref'::text)))))
     LEFT JOIN LATERAL ( SELECT d.name
           FROM public.deal d
          WHERE (d.name ~~* COALESCE((c.payload ->> 'deal'::text), (c.payload ->> 'ref'::text)))
          ORDER BY d.name
         LIMIT 1) named_deal ON ((direct_deal.id IS NULL)))
  WHERE ((c.status = 'pending'::text) AND (s.expires_at > now()));

CREATE VIEW public.v_capture_session_status AS
 SELECT id AS session_id,
    device_id,
    state,
    started_at,
    state_at
   FROM public.capture_session s
  WHERE (expires_at > now());

CREATE VIEW public.v_client_account AS
 SELECT c.id AS client_id,
    c.roster_ref AS client_ref,
    p.name AS client_name,
    c.client_type,
    c.status,
    org.id AS account_party_id,
    org.ref AS account_party_ref,
    org.name AS account_name,
    pc.id AS account_client_id,
    pc.roster_ref AS account_client_ref,
    pc.client_type AS account_client_type,
    ((pc.id IS NOT NULL) AND (pc.id <> c.id)) AS is_sub_client,
    ( SELECT count(*) AS count
           FROM public.deal d
          WHERE (d.client_id = c.id)) AS deals
   FROM (((public.client c
     JOIN public.party p ON ((p.id = c.party_id)))
     LEFT JOIN public.party org ON (((org.id = p.org_id) AND (org.merged_into IS NULL))))
     LEFT JOIN public.client pc ON (((pc.party_id = org.id) AND (pc.merged_into IS NULL) AND (pc.client_type = 'national_account'::text))))
  WHERE (c.merged_into IS NULL);

CREATE VIEW public.v_client_engagement_status AS
 SELECT id AS client_id,
    status AS client_status,
    version AS client_version,
    prospect_engagement_status
   FROM public.client
  WHERE (merged_into IS NULL);

CREATE VIEW public.v_contact AS
 WITH roles AS (
         SELECT p.id AS party_id,
            p.ref,
            p.name,
            p.title,
            p.contact_state,
            ( SELECT c.roster_ref
                   FROM public.client c
                  WHERE ((c.party_id = p.id) AND (c.merged_into IS NULL))
                 LIMIT 1) AS client_ref,
            ( SELECT c.status
                   FROM public.client c
                  WHERE ((c.party_id = p.id) AND (c.merged_into IS NULL))
                 LIMIT 1) AS client_status,
            ( SELECT l.registry_ref
                   FROM public.lead l
                  WHERE (l.party_id = p.id)
                 LIMIT 1) AS lead_ref,
            ( SELECT l.stage
                   FROM public.lead l
                  WHERE (l.party_id = p.id)
                 LIMIT 1) AS lead_stage,
            ( SELECT v.vendor_ref
                   FROM public.vendor v
                  WHERE (v.party_id = p.id)
                 LIMIT 1) AS vendor_ref,
            ( SELECT v.relationship_level
                   FROM public.vendor v
                  WHERE (v.party_id = p.id)
                 LIMIT 1) AS vendor_level
           FROM public.party p
          WHERE ((p.merged_into IS NULL) AND (p.deleted_at IS NULL))
        ), axes AS (
         SELECT r.party_id,
            r.ref,
            r.name,
            r.title,
            r.contact_state,
            r.client_ref,
            r.client_status,
            r.lead_ref,
            r.lead_stage,
            r.vendor_ref,
            r.vendor_level,
            (r.vendor_ref IS NOT NULL) AS is_vendor,
                CASE
                    WHEN (r.client_status = 'past_client'::text) THEN 'past_client'::text
                    WHEN (r.client_ref IS NOT NULL) THEN 'client'::text
                    WHEN (r.lead_stage = ANY (ARRAY['qualified'::text, 'engaged'::text, 'active_deal'::text])) THEN 'prospect'::text
                    WHEN (r.lead_ref IS NOT NULL) THEN 'lead'::text
                    ELSE NULL::text
                END AS journey_stage
           FROM roles r
        )
 SELECT ref,
    name,
    title,
    contact_state,
    journey_stage,
    is_vendor,
    client_ref,
    lead_ref,
    vendor_ref,
    vendor_level,
    NULLIF(TRIM(BOTH ' + '::text FROM concat_ws(' + '::text,
        CASE
            WHEN is_vendor THEN 'Vendor'::text
            ELSE NULL::text
        END,
        CASE journey_stage
            WHEN 'past_client'::text THEN 'Past Client'::text
            WHEN 'client'::text THEN 'Client'::text
            WHEN 'prospect'::text THEN 'Prospect'::text
            WHEN 'lead'::text THEN 'Lead'::text
            ELSE NULL::text
        END)), ''::text) AS contact_type,
    ((journey_stage = 'past_client'::text) AND (contact_state = ANY (ARRAY['active'::text, 'nurture'::text]))) AS prospect_by_default
   FROM axes;

CREATE VIEW public.v_deal_board AS
 SELECT d.id,
    d.name,
    c.roster_ref AS client_ref,
    pc.name AS client_name,
    d.deal_type,
    d.phase,
    ph.sort AS phase_sort,
    d.segment,
    d.outcome,
    lead_actor.slug AS lead_owner,
    lt.last_touch,
    d.notes_path,
    d.invoiced_on,
    d.closed_on,
    d.lane,
    d.client_id
   FROM ((((((public.deal d
     JOIN public.client c ON ((c.id = d.client_id)))
     JOIN public.party pc ON ((pc.id = c.party_id)))
     JOIN public.deal_phase ph ON ((ph.slug = d.phase)))
     LEFT JOIN public.deal_participant dp ON (((dp.deal_id = d.id) AND (dp.role = 'lead'::text) AND (dp.to_at IS NULL))))
     LEFT JOIN public.actor lead_actor ON ((lead_actor.id = dp.actor_id)))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'deal'::text) AND (lt.subject_id = d.id))));

CREATE VIEW public.v_deal_client_portal AS
 SELECT deal_id,
    ('https://share.example.com/'::text || slug) AS client_portal_url
   FROM ops.client_portal
  WHERE (disabled_at IS NULL);

CREATE VIEW public.v_deal_current_action AS
 SELECT DISTINCT ON (subject_id) subject_id AS deal_id,
    id,
    status,
    description
   FROM public.next_action n
  WHERE ((subject_type = 'deal'::text) AND (item_title IS NULL) AND (status = ANY (ARRAY['open'::text, 'done'::text])) AND ((status = 'open'::text) OR (NOT (EXISTS ( SELECT 1
           FROM public.deal_note step
          WHERE ((step.deal_id = n.subject_id) AND (step.kind = 'next_step'::text) AND (step.created_at > n.updated_at)))))) AND (NOT (EXISTS ( SELECT 1
           FROM public.event request
          WHERE ((request.subject_type = 'deal'::text) AND (request.subject_id = n.subject_id) AND (request.field = 'overdue_assessment_pending'::text) AND ((request.new_value ->> 'candidate_kind'::text) = 'next_step'::text) AND ((request.new_value -> 'actions'::text) @> jsonb_build_array(jsonb_build_object('id', (n.id)::text, 'source', 'next_action'))) AND (NOT (EXISTS ( SELECT 1
                   FROM public.event undone
                  WHERE ((undone.subject_type = 'deal'::text) AND (undone.subject_id = n.subject_id) AND (undone.field = 'call_change_undo'::text) AND ((undone.new_value ->> 'candidate_id'::text) = (request.new_value ->> 'candidate_id'::text)))))))))))
  ORDER BY subject_id, (status = 'open'::text) DESC, updated_at DESC, id DESC;

CREATE VIEW public.v_deal_documents AS
 SELECT 'example-tenant'::text AS organization_tenant_id,
    subject_id AS deal_id,
    id,
    filename AS display_name,
    mime AS document_type,
    NULL::integer AS page_count,
    sha256 AS content_hash,
    created_at AS stored_at
   FROM public.attachment a
  WHERE ((subject_type = 'deal'::text) AND (deleted_at IS NULL) AND (EXISTS ( SELECT 1
           FROM public.v_ref_index d
          WHERE ((d.subject_type = 'deal'::text) AND (d.subject_id = a.subject_id)))));

CREATE VIEW public.v_deal_reconciliation_read AS
 SELECT id,
    name,
    salesforce_id,
    version AS base_version,
    phase,
    outcome,
    closed_on,
    invoiced_on,
    lane
   FROM public.deal;

CREATE VIEW public.v_deal_room_board AS
 SELECT d.id,
    d.name,
    d.deal_type AS type,
    d.phase,
    d.owner,
    d.attention,
        CASE
            WHEN (current_action.status = 'done'::text) THEN NULL::date
            ELSE d.next_date
        END AS next_date,
        CASE
            WHEN (current_action.status = 'done'::text) THEN NULL::text
            ELSE COALESCE(current_action.description, ( SELECT n.text
               FROM public.deal_note n
              WHERE ((n.deal_id = d.id) AND (n.kind = 'next_step'::text) AND (NOT (EXISTS ( SELECT 1
                       FROM public.event e
                      WHERE ((e.subject_type = 'deal'::text) AND (e.subject_id = d.id) AND (e.field = 'next_step'::text) AND (e.new_value ? 'superseded_action_ids'::text) AND (e.recorded_at >= n.created_at))))))
              ORDER BY n.created_at DESC, n.id DESC
             LIMIT 1))
        END AS next_step,
    d.city AS market,
    d.segment,
    c.id AS client_id,
    c.roster_ref AS client_ref,
    cp.name AS client_name,
    vca.account_client_id,
    vca.account_client_ref,
    vca.account_name,
    ao.slug AS account_owner,
    dma.agent_name AS market_agent,
    dma.agent_party_id AS market_agent_party_id,
    lt.last_touch,
    ( SELECT max(i.reviewed_at) AS max
           FROM (public.deal_review_item i
             JOIN public.deal_review_session s ON ((s.id = i.session_id)))
          WHERE ((i.deal_id = d.id) AND (i.disposition = 'reviewed'::text) AND (s.status = 'completed'::text))) AS last_review_at,
        CASE
            WHEN (vca.account_client_id IS NULL) THEN 'team'::text
            ELSE 'national_account'::text
        END AS workspace_kind,
    d.operating_state,
    d.parking_reason,
    d.parking_note,
    d.parked_at,
    pa.slug AS parked_by,
    d.invoiced_on,
    d.closed_on,
    d.lane,
    d.outcome
   FROM (((((((((public.deal d
     JOIN public.client c ON ((c.id = d.client_id)))
     JOIN public.party cp ON ((cp.id = c.party_id)))
     LEFT JOIN public.v_client_account vca ON (((vca.client_id = c.id) AND vca.is_sub_client)))
     LEFT JOIN public.national_account_owner nao ON ((nao.account_client_id = vca.account_client_id)))
     LEFT JOIN public.actor ao ON ((ao.id = nao.owner_actor_id)))
     LEFT JOIN public.deal_market_assignment dma ON ((dma.deal_id = d.id)))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'deal'::text) AND (lt.subject_id = d.id))))
     LEFT JOIN public.actor pa ON ((pa.id = d.parked_by)))
     LEFT JOIN public.v_deal_current_action current_action ON ((current_action.deal_id = d.id)))
  WHERE ((d.invoiced_on IS NULL) AND ((c.status <> 'prospect'::text) OR (c.prospect_engagement_status = 'active'::text)));

CREATE VIEW public.v_open_deal_room_board AS
 SELECT id,
    name,
    type,
    phase,
    owner,
    attention,
    next_date,
    next_step,
    market,
    segment,
    client_id,
    client_ref,
    client_name,
    account_client_id,
    account_client_ref,
    account_name,
    account_owner,
    market_agent,
    market_agent_party_id,
    last_touch,
    last_review_at,
    workspace_kind,
    operating_state,
    parking_reason,
    parking_note,
    parked_at,
    parked_by,
    invoiced_on,
    closed_on,
    lane,
    outcome
   FROM public.v_deal_room_board
  WHERE ((outcome IS NULL) AND (closed_on IS NULL) AND (invoiced_on IS NULL) AND (phase <> ALL (ARRAY['closed'::text, 'invoiced'::text])));

CREATE VIEW public.v_deal_room_account AS
 SELECT c.id AS account_client_id,
    c.roster_ref AS account_client_ref,
    p.name AS account_name,
    a.slug AS account_owner,
    count(b.id) FILTER (WHERE (b.operating_state = 'active'::text)) AS open_deals,
    count(b.id) FILTER (WHERE ((b.operating_state = 'active'::text) AND b.attention)) AS attention_deals,
    count(b.id) FILTER (WHERE ((b.operating_state = 'active'::text) AND (b.next_date < CURRENT_DATE))) AS overdue_deals,
    count(b.id) FILTER (WHERE ((b.operating_state = 'active'::text) AND ((b.last_touch IS NULL) OR (b.last_touch < (CURRENT_DATE - 14))))) AS stale_deals,
    ( SELECT max(rs.ended_at) AS max
           FROM public.deal_review_session rs
          WHERE ((rs.account_client_id = c.id) AND (rs.status = 'completed'::text))) AS last_review_at,
    count(b.id) FILTER (WHERE (b.operating_state = 'parked'::text)) AS parked_deals
   FROM ((((public.client c
     JOIN public.party p ON ((p.id = c.party_id)))
     LEFT JOIN public.national_account_owner nao ON ((nao.account_client_id = c.id)))
     LEFT JOIN public.actor a ON ((a.id = nao.owner_actor_id)))
     LEFT JOIN public.v_open_deal_room_board b ON ((b.account_client_id = c.id)))
  WHERE ((c.client_type = 'national_account'::text) AND (c.merged_into IS NULL))
  GROUP BY c.id, c.roster_ref, p.name, a.slug;

CREATE VIEW public.v_deal_room_action AS
 SELECT n.id,
    n.subject_id AS deal_id,
    a.slug AS owner,
    n.description,
    n.due_on,
    n.status,
    n.updated_at,
    n.hold_until,
    n.item_title,
    n.item_bullets,
    n.source_ref,
    n.created_at AS created_order,
    n.version,
    ('next_action:'::text || n.id) AS item_id
   FROM (public.next_action n
     JOIN public.actor a ON ((a.id = n.owner_id)))
  WHERE (n.subject_type = 'deal'::text)
UNION ALL
 SELECT pca.id,
    pca.deal_id,
    a.slug AS owner,
    pca.description,
    pca.due_on,
    pca.status,
    pca.updated_at,
    NULL::date AS hold_until,
    pca.item_title,
    pca.item_bullets,
    pca.source_ref,
    pca.accepted_at AS created_order,
    pca.version,
    ('capture_post_call_action:'::text || pca.id) AS item_id
   FROM (public.capture_post_call_action pca
     JOIN public.actor a ON ((a.id = pca.owner_id)));

CREATE VIEW public.v_deal_room_activity AS
 SELECT x.id,
    x.deal_id,
    x.occurred_at,
    a.slug AS actor,
    x.kind,
    x.summary,
    x.detail,
    x.source,
    (to_jsonb(x.*) -> 'email_context'::text) AS email_context
   FROM (public.activity x
     JOIN public.actor a ON ((a.id = x.actor_id)))
  WHERE (x.deal_id IS NOT NULL);

CREATE VIEW public.v_deal_room_commission AS
 SELECT deal_id,
    id AS commission_id,
    status,
    received_on
   FROM public.commission;

CREATE VIEW public.v_deal_room_critical_date AS
 SELECT id,
    deal_id,
    kind,
    due_on,
    note,
    source,
    status
   FROM public.critical_date c;

CREATE VIEW public.v_deal_room_current_lease AS
 SELECT id,
    deal_id,
    version,
    status,
    executed_on,
    commencement_on,
    expiration_on,
    options_note,
    evidence_kind,
    evidence_ref,
    source
   FROM public.lease
  WHERE (status = 'current'::text);

CREATE VIEW public.v_deal_room_deal AS
 SELECT id,
    phase,
    owner,
    deal_type AS type,
    city,
    segment,
    attention,
    next_date,
    name,
    operating_state,
    parking_reason,
    parking_note,
    parked_at
   FROM public.deal d;

CREATE VIEW public.v_deal_room_document AS
 SELECT id,
    deal_id,
    sent_status,
    lint_passed,
    leak_check_passed,
    prepared_at,
    note
   FROM public.document
  WHERE (deal_id IS NOT NULL);

CREATE VIEW public.v_deal_room_event AS
 SELECT e.id,
    e.recorded_at,
    a.slug AS actor,
    e.verb,
    e.subject_type,
    e.subject_id,
    e.field,
    (e.old_value - ARRAY['sf_commission_placeholder'::text, 'sf_close_date_placeholder'::text]) AS old_value,
    (e.new_value - ARRAY['sf_commission_placeholder'::text, 'sf_close_date_placeholder'::text]) AS new_value,
    e.mutation_order
   FROM (public.event e
     JOIN public.actor a ON ((a.id = e.actor_id)))
  WHERE ((e.subject_type = 'deal'::text) AND (e.field IS DISTINCT FROM 'sf_commission_placeholder'::text) AND (e.field IS DISTINCT FROM 'sf_close_date_placeholder'::text));

CREATE VIEW public.v_deal_room_negotiation AS
 SELECT id,
    deal_id,
    round_no,
    side,
    proposed_on,
    rate_amount,
    rate_basis,
    rate_norm_sf_yr,
    ti_amount,
    ti_basis,
    free_rent_months,
    term_months,
    escalator,
    opex_note,
    expires_on,
    note,
    source
   FROM public.negotiation_round;

CREATE VIEW public.v_deal_room_note AS
 SELECT n.id,
    n.deal_id,
    n.kind,
    n.text,
    a.slug AS actor,
    n.created_at
   FROM (public.deal_note n
     JOIN public.actor a ON ((a.id = n.actor_id)));

CREATE VIEW public.v_deal_room_participant AS
 SELECT dp.id,
    dp.deal_id,
    dp.role,
    COALESCE(a.display_name, p.name) AS name,
    a.slug AS actor,
    p.id AS party_id
   FROM ((public.deal_participant dp
     LEFT JOIN public.actor a ON ((a.id = dp.actor_id)))
     LEFT JOIN public.party p ON ((p.id = dp.party_id)))
  WHERE (dp.to_at IS NULL);

CREATE VIEW public.v_deal_room_phase_change AS
 SELECT DISTINCT ON (subject_id) subject_id AS deal_id,
    id AS event_id,
    (old_value ->> 'phase'::text) AS prior_phase,
    (new_value ->> 'phase'::text) AS phase,
    ((cause = ANY (ARRAY['ingest_email'::text, 'ingest_calendar'::text, 'ingest_webhook'::text, 'automation_job'::text, 'system'::text])) AND (verb <> 'revert-deal-field'::text) AND (NOT ((verb = ANY (ARRAY['patch-deal-field'::text, 'resolve-conflict'::text])) AND (COALESCE(via, ''::text) = 'dealroom-cookie'::text) AND (COALESCE(client_id, ''::text) = 'dealroom-pwa'::text)))) AS automatic,
    COALESCE(NULLIF(agent_rationale, ''::text), 'phase changed'::text) AS reason,
    (to_jsonb(occurred_at) #>> '{}'::text[]) AS evidence_date,
    (to_jsonb(recorded_at) #>> '{}'::text[]) AS recorded_at
   FROM public.event e
  WHERE ((subject_type = 'deal'::text) AND (field = 'phase'::text))
  ORDER BY subject_id, e.recorded_at DESC, id DESC;

CREATE VIEW public.v_deal_room_phase_start AS
 WITH ordered AS (
         SELECT e.subject_id,
            e.id,
            e.recorded_at,
            e.occurred_at,
            e.verb,
            e.old_value,
            e.new_value,
            sum(
                CASE
                    WHEN (e.verb = 'revert-deal-field'::text) THEN 0
                    ELSE 1
                END) OVER (PARTITION BY e.subject_id ORDER BY e.recorded_at, e.id) AS change_group
           FROM public.event e
          WHERE ((e.subject_type = 'deal'::text) AND (e.field = 'phase'::text))
        ), effective AS (
         SELECT ordered.subject_id,
            ordered.change_group,
            (array_agg(ordered.new_value ORDER BY ordered.recorded_at, ordered.id))[1] AS new_value,
            (array_agg(ordered.old_value ORDER BY ordered.recorded_at, ordered.id))[1] AS old_value,
            (array_agg(ordered.occurred_at ORDER BY ordered.recorded_at, ordered.id))[1] AS occurred_at,
            count(*) FILTER (WHERE (ordered.verb = 'revert-deal-field'::text)) AS undos
           FROM ordered
          GROUP BY ordered.subject_id, ordered.change_group
        )
 SELECT subject_id AS deal_id,
    (new_value ->> 'phase'::text) AS phase,
    ((min(occurred_at) AT TIME ZONE 'America/Chicago'::text))::date AS started_on
   FROM effective
  WHERE ((change_group > 0) AND ((undos % (2)::bigint) = 0) AND (NULLIF((new_value ->> 'phase'::text), ''::text) IS NOT NULL) AND ((old_value ->> 'phase'::text) IS DISTINCT FROM (new_value ->> 'phase'::text)))
  GROUP BY subject_id, (new_value ->> 'phase'::text);

CREATE VIEW public.v_deal_room_premises AS
 SELECT pr.id,
    pr.deal_id,
    pr.label,
    b.name AS building_name,
    b.address,
    b.city,
    b.state,
    s.suite,
    s.area_amount,
    s.area_basis,
    pr.created_at
   FROM (((public.premises pr
     LEFT JOIN public.premises_space ps ON ((ps.premises_id = pr.id)))
     LEFT JOIN public.space s ON ((s.id = ps.space_id)))
     LEFT JOIN public.building b ON ((b.id = s.building_id)));

CREATE VIEW public.v_deal_room_presence AS
 SELECT a.slug AS actor,
    p.deal_id,
    p.field,
    p.expires_at
   FROM (public.deal_presence_lease p
     JOIN public.actor a ON ((a.id = p.actor_id)));

CREATE VIEW public.v_deal_room_session AS
SELECT
    NULL::uuid AS session_id,
    NULL::text AS workspace_kind,
    NULL::uuid AS account_client_id,
    NULL::text AS started_by,
    NULL::timestamp with time zone AS started_at,
    NULL::timestamp with time zone AS ended_at,
    NULL::text AS status,
    NULL::text AS summary,
    NULL::bigint AS reviewed_count,
    NULL::bigint AS skipped_count;

CREATE VIEW public.v_deal_room_vendor AS
 SELECT a.deal_id,
    a.party_id,
    a.role,
    jsonb_build_object('id', company.id, 'name', company.name) AS company,
    jsonb_build_object('id', contact.id, 'name', contact.name, 'email', contact.email, 'phone', contact.phone) AS contact,
    a.note,
    (to_jsonb(a.updated_at) #>> '{}'::text[]) AS updated_at
   FROM (((public.deal_vendor_assignment a
     JOIN public.party p ON (((p.id = a.party_id) AND (p.merged_into IS NULL) AND (p.deleted_at IS NULL))))
     JOIN public.party company ON (((company.id = a.company_party_id) AND (company.merged_into IS NULL) AND (company.deleted_at IS NULL))))
     JOIN public.party contact ON (((contact.id = a.contact_party_id) AND (contact.merged_into IS NULL) AND (contact.deleted_at IS NULL))))
  WHERE (a.active AND (EXISTS ( SELECT 1
           FROM public.vendor v
          WHERE ((v.party_id = a.party_id) AND (v.merged_into IS NULL)))));

CREATE VIEW public.v_today_triage AS
 SELECT 'next_action'::text AS item_kind,
    na.id,
    na.subject_type,
    na.subject_id,
    owner.slug AS owner,
    na.description AS what,
    na.due_on,
    COALESCE(r.display_name, r.org_name) AS subject_name,
    r.ref AS subject_ref,
    public.carr_business_days(na.due_on, public.carr_business_date()) AS business_days_overdue
   FROM ((public.next_action na
     JOIN public.actor owner ON ((owner.id = na.owner_id)))
     LEFT JOIN public.v_ref_index r ON (((r.subject_id = na.subject_id) AND (r.subject_type = na.subject_type))))
  WHERE ((na.status = 'open'::text) AND (na.due_on IS NOT NULL) AND (na.due_on <= public.carr_business_date()) AND ((na.hold_until IS NULL) OR (na.hold_until <= public.carr_business_date())))
UNION ALL
 SELECT 'post_call_action'::text AS item_kind,
    pca.id,
    'deal'::text AS subject_type,
    pca.deal_id AS subject_id,
    owner.slug AS owner,
    pca.description AS what,
    pca.due_on,
    COALESCE(r.display_name, r.org_name) AS subject_name,
    r.ref AS subject_ref,
    public.carr_business_days(pca.due_on, public.carr_business_date()) AS business_days_overdue
   FROM ((public.capture_post_call_action pca
     JOIN public.actor owner ON ((owner.id = pca.owner_id)))
     LEFT JOIN public.v_ref_index r ON (((r.subject_id = pca.deal_id) AND (r.subject_type = 'deal'::text))))
  WHERE ((pca.status = 'open'::text) AND (pca.due_on IS NOT NULL) AND (pca.due_on <= public.carr_business_date()))
UNION ALL
 SELECT 'critical_date'::text AS item_kind,
    cd.id,
    'deal'::text AS subject_type,
    cd.deal_id AS subject_id,
    NULL::text AS owner,
    (cd.kind || COALESCE((': '::text || cd.note), ''::text)) AS what,
    cd.due_on,
    COALESCE(r.display_name, r.org_name) AS subject_name,
    r.ref AS subject_ref,
    public.carr_business_days(cd.due_on, public.carr_business_date()) AS business_days_overdue
   FROM (public.critical_date cd
     LEFT JOIN public.v_ref_index r ON (((r.subject_id = cd.deal_id) AND (r.subject_type = 'deal'::text))))
  WHERE ((cd.status = 'open'::text) AND (cd.due_on <= (public.carr_business_date() + 14)))
UNION ALL
 SELECT 'ingest'::text AS item_kind,
    i.id,
    'inbox'::text AS subject_type,
    i.id AS subject_id,
    NULL::text AS owner,
    COALESCE(NULLIF(TRIM(BOTH FROM (i.payload ->> 'summary'::text)), ''::text), NULLIF(TRIM(BOTH FROM (i.payload ->> 'title'::text)), ''::text), NULLIF(TRIM(BOTH FROM (i.payload ->> 'subject'::text)), ''::text), (i.source || ' item awaiting triage'::text)) AS what,
    public.carr_business_date(i.received_at) AS due_on,
    NULLIF(TRIM(BOTH FROM (i.payload ->> 'organizer'::text)), ''::text) AS subject_name,
    NULL::text AS subject_ref,
    public.carr_business_days(public.carr_business_date(i.received_at), public.carr_business_date()) AS business_days_overdue
   FROM public.ingest_inbox i
  WHERE (i.status = 'new'::text);

CREATE VIEW public.v_export_clients AS
 SELECT c.roster_ref AS "Client ID",
    p.name AS "Name",
    org.name AS "Practice / Entity",
    COALESCE(c.owner_label, owner.display_name) AS "Owner",
        CASE
            WHEN (c.merged_into IS NOT NULL) THEN ('Merged into '::text || mt.roster_ref)
            WHEN (c.status = 'active_deal'::text) THEN COALESCE(('Active deal – '::text || ( SELECT ph.label
               FROM (public.deal d
                 JOIN public.deal_phase ph ON ((ph.slug = d.phase)))
              WHERE ((d.client_id = c.id) AND (d.outcome IS NULL))
              ORDER BY d.created_at DESC, d.id DESC
             LIMIT 1)), 'Active deal – no deal on file'::text)
            ELSE cs.label
        END AS "Status",
    c.specialty_type_label AS "Specialty / Type",
    (COALESCE(p.city, ''::text) || COALESCE((', '::text || p.state), ''::text)) AS "Market / Location",
    c.deal_type_label AS "Deal Type",
    c.acquisition_source AS "Referral Source",
    c.contact_label AS "Contact",
    p.phone AS "Phone",
    p.email AS "Email",
    c.possible_duplicate_label AS "Possible Duplicate Of",
    c.notes_path AS "Detail File",
    c.notes AS "Notes"
   FROM (((((public.client c
     JOIN public.party p ON ((p.id = c.party_id)))
     LEFT JOIN public.client_status cs ON ((cs.slug = c.status)))
     LEFT JOIN public.client mt ON ((mt.id = c.merged_into)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
     LEFT JOIN public.actor owner ON ((owner.id = c.owner_id)))
  WHERE (c.roster_ref IS NOT NULL);

CREATE VIEW public.v_export_deals AS
 SELECT d.id,
    d.name,
    d.salesforce_id,
    d.deal_type,
    ph.label AS phase,
    d.segment,
    d.outcome,
    d.closed_on,
    d.notes_path,
    c.roster_ref AS client_ref,
    pc.name AS client_name,
    initcap(lead_actor.slug) AS owner,
    d.sf_commission_placeholder AS "PLACEHOLDER_sf_commission_never_sum",
    d.sf_close_date_placeholder AS "PLACEHOLDER_sf_close_date_never_forecast",
    d.source_row,
    d.city,
    d.lane
   FROM (((((public.deal d
     JOIN public.client c ON ((c.id = d.client_id)))
     JOIN public.party pc ON ((pc.id = c.party_id)))
     JOIN public.deal_phase ph ON ((ph.slug = d.phase)))
     LEFT JOIN public.deal_participant dp ON (((dp.deal_id = d.id) AND (dp.role = 'lead'::text) AND (dp.to_at IS NULL))))
     LEFT JOIN public.actor lead_actor ON ((lead_actor.id = dp.actor_id)));

CREATE VIEW public.v_export_leads AS
 SELECT l.registry_ref AS "Lead ID",
    (l.created_at)::date AS "Date In",
    COALESCE(l.owner_label, owner.display_name) AS "Owner",
    ls.label AS "Stage",
    l.segment AS "Segment",
    p.name AS "Contact Name",
    org.name AS "Practice",
    p.specialty AS "Specialty",
    p.city AS "City/Market",
    p.county AS "County",
    p.email AS "Email",
    p.phone AS "Phone",
    l.source_type AS "Source Type",
    l.source_detail AS "Source Detail (V-ID / event / referrer)",
    COALESCE((l.report_back_due)::text, l.report_back_due_raw) AS "Report-Back Due",
    l.drip_campaign AS "Drip Campaign",
    COALESCE((l.drip_added)::text, l.drip_added_raw) AS "Drip Added",
    na.description AS "Next Action",
    na.due_on AS "Next Action Date",
    lt.last_touch AS "Last Touch",
    l.sf_deal AS "SF Deal",
    l.notes_path AS "Detail File",
    l.notes AS "Notes",
    COALESCE((l.est_lease_event)::text, l.est_lease_event_raw) AS "Est-Lease-Event",
    l.event_source AS "Event-Source",
    l.event_confidence AS "Event-Confidence",
    l.suppressed AS _suppressed
   FROM ((((((public.lead l
     JOIN public.party p ON ((p.id = l.party_id)))
     JOIN public.lead_stage ls ON ((ls.slug = l.stage)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
     LEFT JOIN public.actor owner ON ((owner.id = l.owner_id)))
     LEFT JOIN LATERAL ( SELECT n.description,
            n.due_on
           FROM public.next_action n
          WHERE ((n.subject_type = 'lead'::text) AND (n.subject_id = l.id) AND (n.status = 'open'::text))
          ORDER BY n.due_on, n.created_at, n.id
         LIMIT 1) na ON (true))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'lead'::text) AND (lt.subject_id = l.id))));

CREATE VIEW public.v_export_pool AS
 SELECT source_seq,
    source_key,
    source_row,
    segment AS "SEGMENT",
    segment_play AS "THE PLAY",
    name AS "Name",
    vertical AS "Profession",
    address AS "Practice Address",
    city AS "City",
    county AS "County",
    email AS "Email",
    phone AS "Phone",
    status AS _status,
    dup_tier AS _dup_tier,
    dup_ref AS _dup_ref
   FROM public.candidate_pool pp
  WHERE (source = 'lead-router'::text);

CREATE VIEW public.v_export_pool_all AS
 SELECT source,
    source_seq,
    source_key,
    source_row,
    segment AS "SEGMENT",
    segment_play AS "THE PLAY",
    name AS "Name",
    vertical AS "Profession",
    address AS "Practice Address",
    city AS "City",
    county AS "County",
    email AS "Email",
    phone AS "Phone",
    status AS _status,
    dup_tier AS _dup_tier,
    dup_ref AS _dup_ref,
    est_lease_event,
    est_basis,
    score,
    score_basis
   FROM public.candidate_pool;

CREATE TABLE public.vendor_category (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.vendor_stage (
    slug text NOT NULL,
    label text NOT NULL,
    sort integer DEFAULT 100 NOT NULL
);

CREATE VIEW public.v_export_vendors AS
 SELECT v.vendor_ref AS "ID",
    p.name AS "Name",
    org.name AS "Company",
    COALESCE(vc.label, v.category) AS "Category",
    array_to_string(v.verticals, ', '::text) AS "Vertical",
    p.title AS "Title",
    COALESCE(v.owner_label, owner.display_name) AS "Owner",
    vs.label AS "Stage",
    lt.last_touch AS "Last Touch",
    na.description AS "Next Step",
        CASE
            WHEN v.referral_active THEN 'Yes'::text
            WHEN (NOT v.referral_active) THEN 'No'::text
            ELSE NULL::text
        END AS "Referral-active?",
    v.territory AS "Territory",
    p.state AS "State",
    v.offers AS "Offers",
    v.seeking AS "Seeking",
    v.links_label AS "Links",
    v.rivalry_group AS "Rivalry Group",
    v.originated AS "Originated / Referred",
    p.phone AS "Phone",
    p.email AS "Email",
    v.intro_notes AS "Notes",
        CASE
            WHEN v.enrich THEN 'Yes'::text
            WHEN (NOT v.enrich) THEN 'No'::text
            ELSE NULL::text
        END AS "Enrich?",
    v.out_of_market AS _out_of_market
   FROM (((((((public.vendor v
     JOIN public.party p ON ((p.id = v.party_id)))
     LEFT JOIN public.vendor_stage vs ON ((vs.slug = v.stage)))
     LEFT JOIN public.vendor_category vc ON ((vc.slug = v.category_slug)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
     LEFT JOIN public.actor owner ON ((owner.id = v.owner_id)))
     LEFT JOIN LATERAL ( SELECT n.description
           FROM public.next_action n
          WHERE ((n.subject_type = 'vendor'::text) AND (n.subject_id = v.id) AND (n.status = 'open'::text))
          ORDER BY n.due_on, n.created_at, n.id
         LIMIT 1) na ON (true))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'vendor'::text) AND (lt.subject_id = v.id))))
  WHERE (v.merged_into IS NULL);

CREATE VIEW public.v_lead_board AS
 SELECT l.id,
    l.registry_ref,
    p.name,
    p.specialty,
    p.city,
    p.county,
    p.state,
    l.lane,
    l.stage,
    ls.label AS stage_label,
    ls.sort AS stage_sort,
    l.score,
    l.segment,
    l.suppressed,
    l.est_lease_event,
    l.event_confidence,
    COALESCE(lt.last_touch, l.last_touch) AS last_touch,
    l.next_action_date,
    owner.slug AS owner,
    COALESCE(l.owner_label, initcap(owner.slug)) AS owner_label,
    l.version AS base_version,
    l.created_at,
    l.updated_at,
    l.party_id,
    (l.client_id IS NOT NULL) AS converted,
    COALESCE(moves.items, '[]'::jsonb) AS stage_moves
   FROM (((((public.lead l
     JOIN public.party p ON ((p.id = l.party_id)))
     JOIN public.lead_stage ls ON ((ls.slug = l.stage)))
     LEFT JOIN public.actor owner ON ((owner.id = l.owner_id)))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'lead'::text) AND (lt.subject_id = l.id))))
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('move_id', m.id, 'from_stage', m.from_stage, 'to_stage', m.to_stage, 'reason', m.reason, 'evidence_ref', m.evidence_ref, 'status', m.status, 'created_at', m.created_at, 'undone_at', m.undone_at, 'undone_by', a.display_name) ORDER BY m.created_at, m.id) AS items
           FROM (public.lead_stage_move m
             LEFT JOIN public.actor a ON ((a.id = m.undone_by)))
          WHERE (m.lead_id = l.id)) moves ON (true));

CREATE VIEW public.v_lead_board_stage AS
 SELECT slug,
    label,
    sort
   FROM public.lead_stage;

CREATE VIEW public.v_lead_client_link AS
 SELECT l.id AS lead_id,
    l.registry_ref AS lead_ref,
    lp.name AS lead_name,
    c.id AS client_id,
    c.roster_ref AS client_ref,
    cp.name AS client_name,
    'conversion'::text AS link_basis,
    1 AS basis_rank,
    ((lp.merged_into IS NOT NULL) OR (COALESCE(c.merged_into, cp.merged_into) IS NOT NULL)) AS either_merged
   FROM (((public.lead l
     JOIN public.party lp ON ((lp.id = l.party_id)))
     JOIN public.client c ON ((c.id = l.client_id)))
     JOIN public.party cp ON ((cp.id = c.party_id)))
UNION
 SELECT l.id AS lead_id,
    l.registry_ref AS lead_ref,
    lp.name AS lead_name,
    c.id AS client_id,
    c.roster_ref AS client_ref,
    cp.name AS client_name,
    'same_party'::text AS link_basis,
    2 AS basis_rank,
    ((lp.merged_into IS NOT NULL) OR (COALESCE(c.merged_into, cp.merged_into) IS NOT NULL)) AS either_merged
   FROM (((public.lead l
     JOIN public.party lp ON ((lp.id = l.party_id)))
     JOIN public.party cp ON ((COALESCE(cp.merged_into, cp.id) = COALESCE(lp.merged_into, lp.id))))
     JOIN public.client c ON ((c.party_id = cp.id)))
  WHERE ((lp.deleted_at IS NULL) AND (cp.deleted_at IS NULL))
UNION
 SELECT l.id AS lead_id,
    l.registry_ref AS lead_ref,
    lp.name AS lead_name,
    c.id AS client_id,
    c.roster_ref AS client_ref,
    cp.name AS client_name,
    'same_org'::text AS link_basis,
    3 AS basis_rank,
    ((lp.merged_into IS NOT NULL) OR (COALESCE(c.merged_into, cp.merged_into) IS NOT NULL)) AS either_merged
   FROM (((public.lead l
     JOIN public.party lp ON ((lp.id = l.party_id)))
     JOIN public.party cp ON (((cp.id = lp.org_id) OR (cp.org_id = lp.org_id))))
     JOIN public.client c ON ((c.party_id = cp.id)))
  WHERE ((lp.org_id IS NOT NULL) AND (lp.deleted_at IS NULL) AND (cp.deleted_at IS NULL) AND (COALESCE(lp.merged_into, lp.id) <> COALESCE(cp.merged_into, cp.id)));

CREATE VIEW public.v_lead_client_best AS
 SELECT DISTINCT ON (lead_id) lead_id,
    lead_ref,
    lead_name,
    client_id,
    client_ref,
    client_name,
    link_basis,
    either_merged
   FROM public.v_lead_client_link
  ORDER BY lead_id, basis_rank, client_ref;

CREATE VIEW public.v_lead_hot AS
 SELECT l.id,
    l.registry_ref,
    p.name,
    p.specialty,
    p.city,
    p.county,
    p.state,
    l.lane,
    l.stage,
    l.score,
    l.segment,
    l.suppressed,
    l.est_lease_event,
    l.event_confidence,
    lt.last_touch,
    l.next_action_date
   FROM ((public.lead l
     JOIN public.party p ON ((p.id = l.party_id)))
     LEFT JOIN public.v_last_touch lt ON (((lt.subject_type = 'lead'::text) AND (lt.subject_id = l.id))))
  WHERE (NOT l.suppressed);

CREATE VIEW public.v_lead_prospect_engagement AS
 SELECT l.id AS lead_id,
    c.id AS prospect_client_id,
    c.version AS prospect_client_version,
    c.prospect_engagement_status
   FROM (public.lead l
     JOIN public.client c ON ((c.id = l.client_id)))
  WHERE ((c.status = 'prospect'::text) AND (c.merged_into IS NULL));

CREATE VIEW public.v_lead_stage_transition AS
 SELECT id AS event_id,
    subject_id AS lead_id,
    mutation_order,
    occurred_at,
    (old_value ->> 'stage'::text) AS prior_stage,
    (new_value ->> 'stage'::text) AS stage,
    cause,
    (cause = ANY (ARRAY['automation_job'::text, 'ingest_email'::text, 'ingest_calendar'::text, 'system'::text])) AS automatic,
    agent_rationale AS reason,
    idempotency_key,
    (new_value -> 'stage_review'::text) AS stage_review,
    actor_id,
    ((new_value -> 'transition_proof'::text) ->> 'actor_slug'::text) AS actor_slug,
    (((new_value -> 'transition_proof'::text) ->> 'before_version'::text))::integer AS before_version,
    (((new_value -> 'transition_proof'::text) ->> 'after_version'::text))::integer AS after_version
   FROM public.event e
  WHERE ((subject_type = 'lead'::text) AND ((new_value ->> 'stage'::text) IS NOT NULL));

CREATE VIEW public.v_lead_workspace_lifecycle AS
 WITH live_clients AS MATERIALIZED (
         SELECT cl.id,
            cl.party_id
           FROM (public.client cl
             JOIN public.party cp_1 ON ((cp_1.id = cl.party_id)))
          WHERE ((cl.merged_into IS NULL) AND (cp_1.merged_into IS NULL) AND (cp_1.deleted_at IS NULL))
        ), client_parties AS (
         SELECT DISTINCT live_clients.party_id
           FROM live_clients
        ), linked_leads AS MATERIALIZED (
         SELECT DISTINCT bridge_1.lead_id
           FROM (public.v_lead_client_link bridge_1
             JOIN live_clients cl ON ((cl.id = bridge_1.client_id)))
          WHERE (NOT bridge_1.either_merged)
        ), deal_clients AS (
         SELECT DISTINCT deal.client_id
           FROM public.deal
          WHERE (deal.client_id IS NOT NULL)
        )
 SELECT l.id,
    l.party_id,
    l.client_id,
    l.stage,
    l.suppressed,
    l.owner_id,
    ((p.merged_into IS NULL) AND (p.deleted_at IS NULL)) AS live_party,
    p.contact_state,
    (l.suppressed OR (l.stage = 'do_not_contact'::text) OR (p.contact_state = 'do_not_contact'::text)) AS do_not_contact,
    (NOT (l.suppressed OR (l.stage = 'do_not_contact'::text) OR (p.contact_state = 'do_not_contact'::text))) AS contact_eligible,
    (cp.party_id IS NOT NULL) AS is_client,
    (bridge.lead_id IS NOT NULL) AS linked_client,
    (d.client_id IS NOT NULL) AS is_deal
   FROM ((((public.lead l
     JOIN public.party p ON ((p.id = l.party_id)))
     LEFT JOIN client_parties cp ON ((cp.party_id = p.id)))
     LEFT JOIN linked_leads bridge ON ((bridge.lead_id = l.id)))
     LEFT JOIN deal_clients d ON ((d.client_id = l.client_id)));

CREATE VIEW public.v_lead_workspace AS
 WITH live_clients AS MATERIALIZED (
         SELECT cl.id,
            cp.id AS party_id,
            cp.name,
            lower(TRIM(BOTH FROM cp.name)) AS normalized_name
           FROM (public.client cl
             JOIN public.party cp ON ((cp.id = cl.party_id)))
          WHERE ((cl.merged_into IS NULL) AND (cp.merged_into IS NULL) AND (cp.deleted_at IS NULL))
        ), possible_clients AS MATERIALIZED (
         SELECT p_1.id AS party_id,
            jsonb_agg(jsonb_build_object('client_id', cl.id, 'name', cl.name) ORDER BY cl.id) AS items
           FROM (public.party p_1
             JOIN live_clients cl ON (((cl.normalized_name = lower(TRIM(BOTH FROM p_1.name))) AND (cl.party_id <> p_1.id))))
          GROUP BY p_1.id
        ), last_moves AS MATERIALIZED (
         SELECT DISTINCT ON (e.lead_id) e.lead_id,
            jsonb_build_object('event_id', e.event_id, 'idempotency_key', e.idempotency_key, 'from', e.prior_stage, 'to', e.stage, 'occurred_at', e.occurred_at, 'automatic', e.automatic, 'reason', e.reason, 'evidence_date', (e.stage_review ->> 'evidence_date'::text), 'undone', (e.stage_review ->> 'undo_event_id'::text)) AS item
           FROM public.v_lead_stage_transition e
          ORDER BY e.lead_id, e.mutation_order DESC
        )
 SELECT b.id,
    b.registry_ref,
    b.name,
    b.specialty,
    b.city,
    b.county,
    b.state,
    b.lane,
    b.stage,
    b.stage_label,
    b.stage_sort,
    b.score,
    b.segment,
    b.suppressed,
    b.est_lease_event,
    b.event_confidence,
    b.last_touch,
    b.next_action_date,
    b.owner,
    b.owner_label,
    b.base_version,
    b.created_at,
    b.updated_at,
    life.party_id,
    life.client_id,
    life.is_client,
    life.linked_client,
    life.is_deal,
    life.contact_state,
    life.do_not_contact,
    life.contact_eligible,
        CASE
            WHEN (p.kind = 'person'::text) THEN p.name
            ELSE NULL::text
        END AS doctor_name,
    org.name AS practice_name,
    p.name AS entity_name,
    COALESCE(matches.items, '[]'::jsonb) AS possible_clients,
    last_move.item AS last_stage_move,
    l.score_reason
   FROM ((((((public.v_lead_board b
     JOIN public.v_lead_workspace_lifecycle life ON ((life.id = b.id)))
     JOIN public.lead l ON ((l.id = b.id)))
     JOIN public.party p ON ((p.id = life.party_id)))
     LEFT JOIN public.party org ON ((org.id = p.org_id)))
     LEFT JOIN possible_clients matches ON ((matches.party_id = p.id)))
     LEFT JOIN last_moves last_move ON ((last_move.lead_id = b.id)))
  WHERE ((NOT life.suppressed) AND life.live_party);

CREATE VIEW public.v_lead_workspace_correspondence AS
 SELECT a.id,
    a.lead_id,
    a.kind,
    a.occurred_at,
    a.summary,
    a.detail,
    a.source,
    a.connected
   FROM (public.activity a
     JOIN public.v_lead_workspace b ON ((b.id = a.lead_id)));

CREATE VIEW public.v_lead_workspace_detail AS
 SELECT b.id,
    jsonb_build_object('phone', p.phone, 'email', p.email, 'notes', l.notes, 'est_lease_event', l.est_lease_event, 'segment', l.segment, 'correspondence', COALESCE(c.items, '[]'::jsonb), 'stage_history', COALESCE(h.items, '[]'::jsonb), 'correspondence_coverage', 'captured_entries_only', 'history_limit', 100) AS detail
   FROM ((((public.v_lead_workspace b
     JOIN public.lead l ON ((l.id = b.id)))
     JOIN public.party p ON ((p.id = l.party_id)))
     LEFT JOIN LATERAL ( SELECT jsonb_agg((to_jsonb(a.*) - 'lead_id'::text) ORDER BY a.occurred_at DESC, a.id DESC) AS items
           FROM ( SELECT activity.id,
                    activity.lead_id,
                    activity.kind,
                    activity.occurred_at,
                    activity.summary,
                    activity.detail,
                    activity.source,
                    activity.connected
                   FROM public.activity
                  WHERE (activity.lead_id = b.id)
                  ORDER BY activity.occurred_at DESC, activity.id DESC
                 LIMIT 100) a) c ON (true))
     LEFT JOIN LATERAL ( SELECT jsonb_agg((to_jsonb(e.*) - 'lead_id'::text) ORDER BY e.mutation_order DESC) AS items
           FROM ( SELECT v_lead_stage_transition.event_id,
                    v_lead_stage_transition.lead_id,
                    v_lead_stage_transition.mutation_order,
                    v_lead_stage_transition.occurred_at,
                    v_lead_stage_transition.prior_stage,
                    v_lead_stage_transition.stage,
                    v_lead_stage_transition.cause,
                    v_lead_stage_transition.automatic,
                    v_lead_stage_transition.reason,
                    v_lead_stage_transition.idempotency_key,
                    v_lead_stage_transition.stage_review,
                    v_lead_stage_transition.actor_id,
                    v_lead_stage_transition.actor_slug,
                    v_lead_stage_transition.before_version,
                    v_lead_stage_transition.after_version
                   FROM public.v_lead_stage_transition
                  WHERE (v_lead_stage_transition.lead_id = b.id)
                  ORDER BY v_lead_stage_transition.mutation_order DESC
                 LIMIT 100) e) h ON (true));

CREATE VIEW public.v_lead_workspace_stage_history AS
 SELECT e.event_id,
    e.lead_id,
    e.mutation_order,
    e.occurred_at,
    e.prior_stage,
    e.stage,
    e.cause,
    e.automatic,
    e.reason,
    e.idempotency_key,
    e.stage_review,
    e.actor_id,
    e.actor_slug,
    e.before_version,
    e.after_version
   FROM (public.v_lead_stage_transition e
     JOIN public.v_lead_workspace b ON ((b.id = e.lead_id)));

CREATE VIEW public.v_party_graph AS
 WITH party_ref AS (
         SELECT DISTINCT ON (r.party_id) r.party_id,
            r.ref
           FROM ( SELECT c.party_id,
                    c.roster_ref AS ref,
                    1 AS pref
                   FROM public.client c
                UNION ALL
                 SELECT v.party_id,
                    v.vendor_ref,
                    2
                   FROM public.vendor v
                UNION ALL
                 SELECT l.party_id,
                    l.registry_ref,
                    3
                   FROM public.lead l) r
          ORDER BY r.party_id, (r.ref IS NULL), r.pref
        )
 SELECT fr.ref AS from_ref,
    fp.name AS from_name,
    tr.ref AS to_ref,
    tp.name AS to_name,
    pl.kind,
    pl.note,
    pl.created_at AS linked_at
   FROM ((((public.party_link pl
     JOIN public.party fp ON ((fp.id = pl.from_party)))
     JOIN public.party tp ON ((tp.id = pl.to_party)))
     LEFT JOIN party_ref fr ON ((fr.party_id = pl.from_party)))
     LEFT JOIN party_ref tr ON ((tr.party_id = pl.to_party)));

CREATE VIEW public.v_requirement_request AS
 SELECT id,
    organization_tenant_id,
    deal_id,
    row_key,
    owner,
    due_on,
    document_type,
    source,
    false AS satisfied,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', u.id, 'state', u.state, 'received_at', u.received_at, 'sha256', u.sha256, 'bytes', u.bytes, 'mime', u.mime) ORDER BY u.received_at, u.id) AS jsonb_agg
           FROM ops.requirement_upload_receipt u
          WHERE (u.request_id = r.id)), '[]'::jsonb) AS receipts,
        CASE
            WHEN (fulfilled_at IS NULL) THEN 'open'::text
            ELSE 'fulfilled'::text
        END AS status,
    recipient_email,
    thread_activity_id,
    fulfilled_at,
    fulfilled_by,
    evidence_attachment_id,
    ( SELECT f.filename
           FROM public.attachment f
          WHERE ((f.id = r.evidence_attachment_id) AND (f.subject_type = 'deal'::text) AND (f.subject_id = r.deal_id) AND (f.deleted_at IS NULL))) AS evidence_filename
   FROM ops.requirement_request r;

CREATE VIEW public.v_subject_timeline AS
 SELECT 'activity'::text AS entry_kind,
    a.id,
    a.occurred_at,
    a.recorded_at,
    act.slug AS actor,
    a.kind AS verb,
    a.summary,
    a.detail,
    a.owed,
    COALESCE(a.deal_id, a.client_id, a.lead_id, a.vendor_id) AS subject_id,
        CASE
            WHEN (a.deal_id IS NOT NULL) THEN 'deal'::text
            WHEN (a.client_id IS NOT NULL) THEN 'client'::text
            WHEN (a.lead_id IS NOT NULL) THEN 'lead'::text
            ELSE 'vendor'::text
        END AS subject_type
   FROM (public.activity a
     JOIN public.actor act ON ((act.id = a.actor_id)))
  WHERE (a.party_id IS NULL)
UNION ALL
 SELECT 'activity'::text AS entry_kind,
    a.id,
    a.occurred_at,
    a.recorded_at,
    act.slug AS actor,
    a.kind AS verb,
    a.summary,
    a.detail,
    a.owed,
    a.party_id AS subject_id,
    'party'::text AS subject_type
   FROM (public.activity a
     JOIN public.actor act ON ((act.id = a.actor_id)))
  WHERE (a.party_id IS NOT NULL)
UNION ALL
 SELECT 'event'::text AS entry_kind,
    e.id,
    e.occurred_at,
    e.recorded_at,
    act.slug AS actor,
    e.verb,
    COALESCE(NULLIF(btrim((e.new_value ->> 'summary'::text)), ''::text), e.field, e.verb) AS summary,
    e.human_quote AS detail,
    NULL::text AS owed,
    e.subject_id,
    e.subject_type
   FROM (public.event e
     JOIN public.actor act ON ((act.id = e.actor_id)));

CREATE VIEW public.v_vendor_assignment_context AS
 SELECT v.id,
    v.vendor_ref AS ref,
    v.version AS base_version,
    p.vendor_assignment_version AS assignment_version,
    v.party_id,
        CASE
            WHEN (company.id IS NOT NULL) THEN jsonb_build_object('id', company.id, 'name', company.name)
            ELSE NULL::jsonb
        END AS company,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', contact.id, 'name', contact.name) ORDER BY contact.name, contact.id) AS jsonb_agg
           FROM public.party contact
          WHERE ((contact.kind = 'person'::text) AND (contact.merged_into IS NULL) AND (contact.deleted_at IS NULL) AND (((p.kind = 'person'::text) AND (contact.id = p.id)) OR ((p.kind = 'org'::text) AND (contact.org_id = p.id))))), '[]'::jsonb) AS contacts
   FROM ((public.vendor v
     JOIN public.party p ON ((p.id = v.party_id)))
     LEFT JOIN public.party company ON (((company.id =
        CASE
            WHEN (p.kind = 'org'::text) THEN p.id
            ELSE p.org_id
        END) AND (company.kind = 'org'::text) AND (company.merged_into IS NULL) AND (company.deleted_at IS NULL))))
  WHERE ((v.merged_into IS NULL) AND (p.merged_into IS NULL) AND (p.deleted_at IS NULL));

CREATE VIEW public.v_vendor_level_suggestion AS
 WITH contact AS (
         SELECT v.id AS vendor_id,
            count(*) FILTER (WHERE ((a.kind = ANY (ARRAY['meeting'::text, 'tour'::text, 'loi'::text, 'lease_signed'::text, 'email_in'::text, 'counter_received'::text])) OR ((a.kind = ANY (ARRAY['call'::text, 'text'::text])) AND (a.connected IS TRUE)))) AS two_way,
            count(*) FILTER (WHERE ((a.kind = 'email_out'::text) OR ((a.kind = ANY (ARRAY['call'::text, 'text'::text])) AND (a.connected IS NOT TRUE)))) AS attempts_only
           FROM (public.vendor v
             LEFT JOIN public.activity a ON ((a.vendor_id = v.id)))
          GROUP BY v.id
        ), value_moved AS (
         SELECT v.id AS vendor_id,
            count(*) FILTER (WHERE (pl.via_party = v.party_id)) AS they_gave,
            count(*) FILTER (WHERE ((pl.via_party IN ( SELECT party.id
                   FROM public.party
                  WHERE (party.name = ANY (ARRAY['Test Partner One'::text, 'Test Partner Two'::text])))) AND ((pl.from_party = v.party_id) OR (pl.to_party = v.party_id)))) AS we_gave
           FROM (public.vendor v
             LEFT JOIN public.party_link pl ON (((pl.kind = ANY (ARRAY['introduced'::text, 'referred'::text])) AND ((pl.via_party = v.party_id) OR (pl.from_party = v.party_id) OR (pl.to_party = v.party_id)))))
          GROUP BY v.id
        ), scored AS (
         SELECT v.vendor_ref,
            p.name,
            v.relationship_level AS recorded,
            c.two_way,
            c.attempts_only,
            vm.they_gave,
            vm.we_gave,
            (((c.two_way + c.attempts_only) + vm.they_gave) + vm.we_gave) AS evidence_events,
                CASE
                    WHEN ((((c.two_way + c.attempts_only) + vm.they_gave) + vm.we_gave) = 0) THEN NULL::integer
                    WHEN ((vm.they_gave > 1) AND (vm.we_gave > 1)) THEN 3
                    WHEN ((vm.they_gave > 0) OR (vm.we_gave > 0)) THEN 2
                    WHEN (c.two_way > 0) THEN 1
                    ELSE 0
                END AS suggested
           FROM (((public.vendor v
             JOIN public.party p ON ((p.id = v.party_id)))
             JOIN contact c ON ((c.vendor_id = v.id)))
             JOIN value_moved vm ON ((vm.vendor_id = v.id)))
          WHERE ((v.disposition = 'active'::text) AND (v.merged_into IS NULL))
        )
 SELECT vendor_ref,
    name,
    recorded,
    suggested,
    ((recorded IS NOT NULL) AND (suggested IS NOT NULL) AND (recorded <> suggested)) AS disagrees,
        CASE
            WHEN (evidence_events = 0) THEN 'no_evidence'::text
            WHEN (recorded IS NULL) THEN 'unjudged_with_evidence'::text
            WHEN (recorded = suggested) THEN 'agrees'::text
            WHEN (suggested > recorded) THEN 'evidence_exceeds_recorded'::text
            ELSE 'recorded_exceeds_evidence'::text
        END AS signal,
    evidence_events,
    two_way,
    attempts_only,
    they_gave,
    we_gave
   FROM scored s;

CREATE TABLE public.vendor_disposition (
    slug text NOT NULL,
    label text NOT NULL,
    workable boolean NOT NULL,
    sort integer NOT NULL
);

CREATE TABLE public.vendor_market (
    slug text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    boundary text NOT NULL,
    source text NOT NULL,
    reviewed_by uuid NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    CONSTRAINT vendor_market_boundary_check CHECK (((length(btrim(boundary)) >= 1) AND (length(btrim(boundary)) <= 4000))),
    CONSTRAINT vendor_market_kind_check CHECK ((kind = ANY (ARRAY['market'::text, 'regional'::text]))),
    CONSTRAINT vendor_market_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT vendor_market_slug_check CHECK (((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (length(slug) <= 100))),
    CONSTRAINT vendor_market_source_check CHECK (((length(btrim(source)) >= 1) AND (length(btrim(source)) <= 2000)))
);

CREATE TABLE public.vendor_market_key (
    key text NOT NULL,
    market_slug text NOT NULL,
    CONSTRAINT vendor_market_key_key_check CHECK (((key = lower(btrim(key))) AND ((length(key) >= 1) AND (length(key) <= 200))))
);

CREATE TABLE public.vendor_market_membership (
    market_slug text NOT NULL,
    vendor_id uuid NOT NULL,
    office_presence boolean NOT NULL,
    service_coverage text,
    source text NOT NULL,
    reviewed_by uuid NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    CONSTRAINT vendor_market_membership_check CHECK ((office_presence OR (service_coverage IS NOT NULL))),
    CONSTRAINT vendor_market_membership_service_coverage_check CHECK (((length(btrim(service_coverage)) >= 1) AND (length(btrim(service_coverage)) <= 4000))),
    CONSTRAINT vendor_market_membership_source_check CHECK (((length(btrim(source)) >= 1) AND (length(btrim(source)) <= 2000)))
);

CREATE TABLE public.vendor_market_regional_reference (
    market_slug text NOT NULL,
    regional_slug text NOT NULL,
    note text NOT NULL,
    source text NOT NULL,
    reviewed_by uuid NOT NULL,
    reviewed_at timestamp with time zone NOT NULL,
    market_kind text DEFAULT 'market'::text NOT NULL,
    regional_kind text DEFAULT 'regional'::text NOT NULL,
    CONSTRAINT vendor_market_regional_reference_check CHECK ((market_slug <> regional_slug)),
    CONSTRAINT vendor_market_regional_reference_market_kind_check CHECK ((market_kind = 'market'::text)),
    CONSTRAINT vendor_market_regional_reference_note_check CHECK (((length(btrim(note)) >= 1) AND (length(btrim(note)) <= 4000))),
    CONSTRAINT vendor_market_regional_reference_regional_kind_check CHECK ((regional_kind = 'regional'::text)),
    CONSTRAINT vendor_market_regional_reference_source_check CHECK (((length(btrim(source)) >= 1) AND (length(btrim(source)) <= 2000)))
);

CREATE TABLE public.vendor_relationship_level (
    level integer NOT NULL,
    label text NOT NULL,
    note text NOT NULL
);

ALTER TABLE ONLY public.room_dispatch_link ALTER COLUMN id SET DEFAULT nextval('public.room_dispatch_link_id_seq'::regclass);

ALTER TABLE ONLY ops.client_portal
    ADD CONSTRAINT client_portal_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_id_organization_tenant_id_deal_id_row_k_key UNIQUE (id, organization_tenant_id, deal_id, row_key);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_organization_tenant_id_deal_id_row_key_key UNIQUE (organization_tenant_id, deal_id, row_key);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ops.requirement_upload_grant
    ADD CONSTRAINT requirement_upload_grant_id_request_id_key UNIQUE (id, request_id);

ALTER TABLE ONLY ops.requirement_upload_receipt
    ADD CONSTRAINT requirement_upload_receipt_grant_id_key UNIQUE (grant_id);

ALTER TABLE ONLY ops.requirement_upload_receipt
    ADD CONSTRAINT requirement_upload_receipt_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ops.requirement_upload_receipt
    ADD CONSTRAINT requirement_upload_receipt_r2_key_key UNIQUE (r2_key);

ALTER TABLE ONLY public.activity_kind
    ADD CONSTRAINT activity_kind_pkey PRIMARY KEY (slug);

ALTER TABLE public.activity
    ADD CONSTRAINT activity_party_exclusive CHECK (((party_id IS NULL) OR (num_nonnulls(deal_id, client_id, lead_id, vendor_id) = 0))) NOT VALID;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.actor
    ADD CONSTRAINT actor_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.actor
    ADD CONSTRAINT actor_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.agent_profile
    ADD CONSTRAINT agent_profile_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_profile
    ADD CONSTRAINT agent_profile_profile_key_key UNIQUE (profile_key);

ALTER TABLE ONLY public.agreement
    ADD CONSTRAINT agreement_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT allocation_id_commission_unique UNIQUE (id, commission_id);

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_r2_key_key UNIQUE (r2_key);

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.building_ownership
    ADD CONSTRAINT building_ownership_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.building
    ADD CONSTRAINT building_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cadence_rule
    ADD CONSTRAINT cadence_rule_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.campaign
    ADD CONSTRAINT campaign_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_candidate
    ADD CONSTRAINT capture_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_candidate
    ADD CONSTRAINT capture_candidate_session_id_idempotency_key_item_index_key UNIQUE (session_id, idempotency_key, item_index);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_candidate_id_key UNIQUE (candidate_id);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_session_id_idempotency_key_item_key UNIQUE (session_id, idempotency_key, item_index);

ALTER TABLE ONLY public.capture_session
    ADD CONSTRAINT capture_session_nonce_key UNIQUE (nonce);

ALTER TABLE ONLY public.capture_session
    ADD CONSTRAINT capture_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_session
    ADD CONSTRAINT capture_session_session_token_hash_key UNIQUE (session_token_hash);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_roster_ref_key UNIQUE (roster_ref);

ALTER TABLE ONLY public.client_status
    ADD CONSTRAINT client_status_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.client_type
    ADD CONSTRAINT client_type_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT commission_allocation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.code_subject
    ADD CONSTRAINT code_subject_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commission
    ADD CONSTRAINT commission_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comp
    ADD CONSTRAINT comp_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contact_state
    ADD CONSTRAINT contact_state_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.contact_state
    ADD CONSTRAINT contact_state_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.critical_date
    ADD CONSTRAINT critical_date_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_evidence_ref_key UNIQUE (evidence_ref);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_lane
    ADD CONSTRAINT deal_lane_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.deal_market_assignment
    ADD CONSTRAINT deal_market_assignment_pkey PRIMARY KEY (deal_id);

ALTER TABLE ONLY public.deal_note
    ADD CONSTRAINT deal_note_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_phase
    ADD CONSTRAINT deal_phase_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal_presence_lease
    ADD CONSTRAINT deal_presence_lease_pkey PRIMARY KEY (actor_id, deal_id, field);

ALTER TABLE ONLY public.deal_reattach_log
    ADD CONSTRAINT deal_reattach_log_pkey PRIMARY KEY (deal_id, from_client);

ALTER TABLE ONLY public.deal_review_item
    ADD CONSTRAINT deal_review_item_pkey PRIMARY KEY (session_id, deal_id);

ALTER TABLE ONLY public.deal_review_session
    ADD CONSTRAINT deal_review_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_salesforce_id_key UNIQUE (salesforce_id);

ALTER TABLE ONLY public.deal_type_ref
    ADD CONSTRAINT deal_type_ref_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_pkey PRIMARY KEY (deal_id, party_id, role);

ALTER TABLE ONLY public.doc_template
    ADD CONSTRAINT doc_template_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doc_template
    ADD CONSTRAINT doc_template_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.doctrine_change_set
    ADD CONSTRAINT doctrine_change_set_actor_id_idempotency_key_key UNIQUE (actor_id, idempotency_key);

ALTER TABLE ONLY public.doctrine_change_set
    ADD CONSTRAINT doctrine_change_set_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_concept_id_section_id_role_key UNIQUE (concept_id, section_id, role);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_document
    ADD CONSTRAINT doctrine_document_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_document
    ADD CONSTRAINT doctrine_document_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_edge_type
    ADD CONSTRAINT doctrine_edge_type_pkey PRIMARY KEY (edge_type);

ALTER TABLE ONLY public.doctrine_gate_check
    ADD CONSTRAINT doctrine_gate_check_pkey PRIMARY KEY (check_key);

ALTER TABLE ONLY public.doctrine_gate_run
    ADD CONSTRAINT doctrine_gate_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_link
    ADD CONSTRAINT doctrine_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_meta
    ADD CONSTRAINT doctrine_meta_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_review_policy
    ADD CONSTRAINT doctrine_review_policy_name_key UNIQUE (name);

ALTER TABLE ONLY public.doctrine_review_policy
    ADD CONSTRAINT doctrine_review_policy_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_section_id_version_key UNIQUE (section_id, version);

ALTER TABLE ONLY public.doctrine_section
    ADD CONSTRAINT doctrine_section_document_id_section_key_key UNIQUE (document_id, section_key);

ALTER TABLE ONLY public.doctrine_section
    ADD CONSTRAINT doctrine_section_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctrine_slug_alias
    ADD CONSTRAINT doctrine_slug_alias_pkey PRIMARY KEY (alias_slug);

ALTER TABLE ONLY public.doctrine_snapshot
    ADD CONSTRAINT doctrine_snapshot_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_kind_deal_id_activity_id_key UNIQUE NULLS NOT DISTINCT (kind, deal_id, activity_id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ingest_inbox
    ADD CONSTRAINT ingest_inbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ingest_inbox
    ADD CONSTRAINT ingest_inbox_source_external_id_key UNIQUE (source, external_id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_lead_id_key UNIQUE (lead_id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_lane
    ADD CONSTRAINT lead_lane_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_registry_ref_key UNIQUE (registry_ref);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_lead_id_from_stage_to_stage_activity_id_key UNIQUE (lead_id, from_stage, to_stage, activity_id);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_stage
    ADD CONSTRAINT lead_stage_pkey PRIMARY KEY (slug);

ALTER TABLE public.lease
    ADD CONSTRAINT lease_current_provider_contract_check CHECK (((status <> 'current'::text) OR ((deal_id IS NOT NULL) AND (client_id IS NOT NULL) AND (owner_id IS NOT NULL) AND (executed_on IS NOT NULL) AND (expiration_on IS NOT NULL) AND (evidence_kind IS NOT NULL) AND (NULLIF(btrim(evidence_ref), ''::text) IS NOT NULL) AND (NULLIF(btrim(source), ''::text) IS NOT NULL) AND ((commencement_on IS NULL) OR (expiration_on > commencement_on))))) NOT VALID;

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.loop_block
    ADD CONSTRAINT loop_block_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.loop_block
    ADD CONSTRAINT loop_block_rel_path_seq_key UNIQUE (rel_path, seq);

ALTER TABLE ONLY public.loop_domain
    ADD CONSTRAINT loop_domain_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.loop_domain
    ADD CONSTRAINT loop_domain_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_block_id_render_seq_key UNIQUE (block_id, render_seq);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marketing_subject
    ADD CONSTRAINT marketing_subject_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marketing_subject
    ADD CONSTRAINT marketing_subject_subject_type_slug_key UNIQUE (subject_type, slug);

ALTER TABLE ONLY public.national_account_owner
    ADD CONSTRAINT national_account_owner_pkey PRIMARY KEY (account_client_id);

ALTER TABLE ONLY public.negotiation_claim
    ADD CONSTRAINT negotiation_claim_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.negotiation_claim
    ADD CONSTRAINT negotiation_claim_round_id_claim_type_key UNIQUE (round_id, claim_type);

ALTER TABLE ONLY public.negotiation_claim_type
    ADD CONSTRAINT negotiation_claim_type_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.negotiation_claim_type
    ADD CONSTRAINT negotiation_claim_type_slug_derived_key UNIQUE (slug, derived);

ALTER TABLE ONLY public.negotiation_claim_type
    ADD CONSTRAINT negotiation_claim_type_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_deal_id_round_no_side_key UNIQUE (deal_id, round_no, side);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.next_action
    ADD CONSTRAINT next_action_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.parcel
    ADD CONSTRAINT parcel_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.parcel
    ADD CONSTRAINT parcel_state_county_parcel_no_key UNIQUE (state, county, parcel_no);

ALTER TABLE ONLY public.participant_role
    ADD CONSTRAINT participant_role_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.partner_room_turn
    ADD CONSTRAINT partner_room_turn_msg_id_unique UNIQUE (msg_id);

ALTER TABLE ONLY public.partner_room_turn
    ADD CONSTRAINT partner_room_turn_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.party_link_deal
    ADD CONSTRAINT party_link_deal_pkey PRIMARY KEY (link_id, deal_id);

ALTER TABLE ONLY public.party_link_kind
    ADD CONSTRAINT party_link_kind_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.premises
    ADD CONSTRAINT premises_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.premises_space
    ADD CONSTRAINT premises_space_pkey PRIMARY KEY (premises_id, space_id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT prospect_pool_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT prospect_pool_source_source_key_key UNIQUE (source, source_key);

ALTER TABLE ONLY public.record_flag
    ADD CONSTRAINT record_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.record_source
    ADD CONSTRAINT record_source_source_system_external_key_key UNIQUE (source_system, external_key);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.retrieval_concept
    ADD CONSTRAINT retrieval_concept_concept_key_key UNIQUE (concept_key);

ALTER TABLE ONLY public.retrieval_concept
    ADD CONSTRAINT retrieval_concept_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_dispatch_link
    ADD CONSTRAINT room_dispatch_link_dispatch_ref_key UNIQUE (dispatch_ref);

ALTER TABLE ONLY public.room_dispatch_link
    ADD CONSTRAINT room_dispatch_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);

ALTER TABLE ONLY public.signal_event
    ADD CONSTRAINT signal_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.signal_event
    ADD CONSTRAINT signal_event_producer_signal_key_key UNIQUE (producer, signal_key);

ALTER TABLE ONLY public.space
    ADD CONSTRAINT space_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.space_search
    ADD CONSTRAINT space_search_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.submarket_condition
    ADD CONSTRAINT submarket_condition_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.submarket_condition
    ADD CONSTRAINT submarket_condition_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.tool_call
    ADD CONSTRAINT tool_call_pkey PRIMARY KEY (idempotency_key);

ALTER TABLE ONLY public.vendor_category
    ADD CONSTRAINT vendor_category_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.vendor_category
    ADD CONSTRAINT vendor_category_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.vendor_disposition
    ADD CONSTRAINT vendor_disposition_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.vendor_disposition
    ADD CONSTRAINT vendor_disposition_sort_key UNIQUE (sort);

ALTER TABLE ONLY public.vendor_market_key
    ADD CONSTRAINT vendor_market_key_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.vendor_market_membership
    ADD CONSTRAINT vendor_market_membership_pkey PRIMARY KEY (market_slug, vendor_id);

ALTER TABLE ONLY public.vendor_market
    ADD CONSTRAINT vendor_market_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_reference_pkey PRIMARY KEY (market_slug, regional_slug);

ALTER TABLE ONLY public.vendor_market
    ADD CONSTRAINT vendor_market_slug_kind_key UNIQUE (slug, kind);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendor_relationship_level
    ADD CONSTRAINT vendor_relationship_level_pkey PRIMARY KEY (level);

ALTER TABLE ONLY public.vendor_stage
    ADD CONSTRAINT vendor_stage_pkey PRIMARY KEY (slug);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_vendor_ref_key UNIQUE (vendor_ref);

CREATE UNIQUE INDEX client_portal_one_active_per_deal ON ops.client_portal USING btree (deal_id) WHERE (disabled_at IS NULL);

CREATE INDEX requirement_upload_receipt_request ON ops.requirement_upload_receipt USING btree (request_id);

CREATE UNIQUE INDEX activity_calendar_event_deal_uidx ON public.activity USING btree (calendar_event_key, deal_id) WHERE (calendar_event_key IS NOT NULL);

CREATE INDEX activity_deal_idx ON public.activity USING btree (deal_id, occurred_at DESC);

CREATE UNIQUE INDEX activity_email_identity ON public.activity USING btree (((email_identity ->> 'mailbox_owner'::text)), ((email_identity ->> 'mailbox_account'::text)), ((email_identity ->> 'item_id'::text)), ((email_identity ->> 'subject'::text))) WHERE (email_identity IS NOT NULL);

CREATE INDEX activity_lead_timeline_idx ON public.activity USING btree (lead_id, occurred_at DESC, id DESC) WHERE (lead_id IS NOT NULL);

CREATE INDEX activity_party_timeline_idx ON public.activity USING btree (party_id, occurred_at DESC, id DESC) WHERE (party_id IS NOT NULL);

CREATE INDEX activity_subject_timeline ON public.activity USING btree ((
CASE
    WHEN (deal_id IS NOT NULL) THEN 'deal'::text
    WHEN (client_id IS NOT NULL) THEN 'client'::text
    WHEN (lead_id IS NOT NULL) THEN 'lead'::text
    ELSE 'vendor'::text
END), COALESCE(deal_id, client_id, lead_id, vendor_id), occurred_at DESC);

CREATE INDEX activity_vendor_contact_order ON public.activity USING btree (vendor_id, occurred_at DESC, id DESC) WHERE (vendor_id IS NOT NULL);

CREATE INDEX building_merged_idx ON public.building USING btree (merged_into) WHERE (merged_into IS NOT NULL);

CREATE INDEX building_ownership_bldg_idx ON public.building_ownership USING btree (building_id) WHERE (to_on IS NULL);

CREATE UNIQUE INDEX campaign_name_uniq ON public.campaign USING btree (lower(btrim(name)));

CREATE INDEX candidate_pool_declined_idx ON public.candidate_pool USING btree (declined_at) WHERE (status = 'declined'::text);

CREATE INDEX capture_candidate_queue_idx ON public.capture_candidate USING btree (session_id, status, confidence DESC, created_at, id);

CREATE INDEX capture_post_call_action_deal_history_idx ON public.capture_post_call_action USING btree (deal_id, accepted_at, id);

CREATE INDEX capture_post_call_action_open_due_idx ON public.capture_post_call_action USING btree (due_on, id) WHERE ((status = 'open'::text) AND (due_on IS NOT NULL));

CREATE INDEX capture_post_call_candidate_session_idx ON public.capture_post_call_candidate USING btree (session_id, status, created_at, id);

CREATE INDEX capture_session_active_idx ON public.capture_session USING btree (expires_at, state);

CREATE INDEX client_merged_idx ON public.client USING btree (merged_into) WHERE (merged_into IS NOT NULL);

CREATE INDEX critical_date_deal_due_idx ON public.critical_date USING btree (deal_id, due_on, id);

CREATE INDEX critical_date_open_due_idx ON public.critical_date USING btree (due_on, id) WHERE (status = 'open'::text);

CREATE INDEX deal_client_closed_idx ON public.deal USING btree (client_id, closed_on DESC NULLS LAST);

CREATE INDEX deal_client_need_deal ON public.deal_client_need USING btree (deal_id, id);

CREATE INDEX deal_client_need_vendor ON public.deal_client_need USING btree (vendor_id, id);

CREATE INDEX deal_conflict_open_idx ON public.deal_conflict USING btree (deal_id, field, created_at DESC) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX deal_item_source_unique ON public.next_action USING btree (subject_id, source_ref, item_title) WHERE ((subject_type = 'deal'::text) AND (item_title IS NOT NULL));

CREATE INDEX deal_note_thread_idx ON public.deal_note USING btree (deal_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX deal_one_current_lead ON public.deal_participant USING btree (deal_id) WHERE ((role = 'lead'::text) AND (to_at IS NULL));

CREATE UNIQUE INDEX deal_participant_one_current_lead ON public.deal_participant USING btree (deal_id) WHERE ((role = 'lead'::text) AND (to_at IS NULL));

CREATE INDEX deal_presence_live_idx ON public.deal_presence_lease USING btree (expires_at);

CREATE INDEX deal_review_item_deal_idx ON public.deal_review_item USING btree (deal_id, reviewed_at DESC);

CREATE UNIQUE INDEX deal_review_one_open_per_actor_workspace ON public.deal_review_session USING btree (started_by, workspace_kind, COALESCE(account_client_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX deal_vendor_assignment_active_contact ON public.deal_vendor_assignment USING btree (deal_id, role, contact_party_id) WHERE active;

CREATE INDEX doctrine_concept_mapping_active_section_idx ON public.doctrine_concept_mapping USING btree (section_id) WHERE (status = 'approved'::text);

CREATE INDEX doctrine_document_class_idx ON public.doctrine_document USING btree (content_class, updated_at DESC);

CREATE INDEX doctrine_document_title_search_idx ON public.doctrine_document USING gin (title_search_vector);

CREATE UNIQUE INDEX doctrine_edge_live_uq ON public.doctrine_edge USING btree (source_section_id, target_section_id, edge_type) WHERE (retired_by_revision_id IS NULL);

CREATE INDEX doctrine_edge_source_idx ON public.doctrine_edge USING btree (source_section_id, edge_type);

CREATE INDEX doctrine_edge_target_idx ON public.doctrine_edge USING btree (target_section_id, edge_type);

CREATE INDEX doctrine_link_source_idx ON public.doctrine_link USING btree (source_section_id);

CREATE INDEX doctrine_link_target_idx ON public.doctrine_link USING btree (target_kind, target_id);

CREATE INDEX doctrine_revision_search_idx ON public.doctrine_revision USING gin (search_vector);

CREATE INDEX doctrine_revision_section_idx ON public.doctrine_revision USING btree (section_id, created_at DESC);

CREATE INDEX doctrine_section_doc_idx ON public.doctrine_section USING btree (document_id, ordinal);

CREATE INDEX doctrine_section_review_idx ON public.doctrine_section USING btree (review_after) WHERE (review_after IS NOT NULL);

CREATE INDEX doctrine_section_title_search_idx ON public.doctrine_section USING gin (title_search_vector);

CREATE INDEX email_proposal_outbox ON public.email_proposal USING btree (owner, submitted_at, id) WHERE (status = 'approved_to_send'::text);

CREATE INDEX email_proposal_pending ON public.email_proposal USING btree (created_at, id) WHERE (status = 'pending'::text);

CREATE INDEX email_proposal_recent_outcomes ON public.email_proposal USING btree (owner, result_recorded_at DESC, id DESC) WHERE ((kind = 'reply_draft'::text) AND (status = ANY (ARRAY['sent'::text, 'failed'::text])) AND (result_recorded_at IS NOT NULL));

CREATE INDEX event_actor_idx ON public.event USING btree (actor_id, occurred_at);

CREATE INDEX event_correlation_idx ON public.event USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);

CREATE INDEX event_deal_cursor_idx ON public.event USING btree (recorded_at, id) WHERE (subject_type = 'deal'::text);

CREATE UNIQUE INDEX event_email_touch_original_key ON public.event USING btree (idempotency_key) WHERE ((verb = 'log-activity'::text) AND (new_value ? 'email_application'::text));

CREATE UNIQUE INDEX event_email_touch_target ON public.event USING btree (actor_id, public.digest((new_value #>> '{email_application,binding,source_id}'::text[]), 'sha256'::text), public.digest((new_value #>> '{email_application,binding,source_version}'::text[]), 'sha256'::text), ((new_value #>> '{email_application,binding,target_type}'::text[])), ((new_value #>> '{email_application,binding,target_id}'::text[]))) WHERE ((verb = 'log-activity'::text) AND (new_value ? 'email_application'::text));

CREATE INDEX event_idem_idx ON public.event USING btree (idempotency_key);

CREATE INDEX event_lead_stage_mutation_idx ON public.event USING btree (subject_id, mutation_order DESC) WHERE ((subject_type = 'lead'::text) AND ((new_value ->> 'stage'::text) IS NOT NULL));

CREATE INDEX event_subject_idx ON public.event USING btree (subject_type, subject_id, occurred_at);

CREATE INDEX ingest_inbox_new_received_idx ON public.ingest_inbox USING btree (received_at, id) WHERE (status = 'new'::text);

CREATE UNIQUE INDEX lease_one_current_per_deal ON public.lease USING btree (deal_id) WHERE (status = 'current'::text);

CREATE INDEX lease_renewal_owner_expiration_idx ON public.lease USING btree (owner_id, expiration_on) WHERE (status = 'current'::text);

CREATE UNIQUE INDEX loop_block_key_idx ON public.loop_block USING btree (rel_path, block_key) WHERE (block_key IS NOT NULL);

CREATE INDEX loop_item_block_idx ON public.loop_item USING btree (block_id, render_seq);

CREATE INDEX loop_item_domain_idx ON public.loop_item USING btree (domain, status);

CREATE INDEX loop_item_drift_idx ON public.loop_item USING btree (drift_critical) WHERE drift_critical;

CREATE INDEX loop_item_due_idx ON public.loop_item USING btree (due_on) WHERE (due_on IS NOT NULL);

CREATE INDEX loop_item_kind_idx ON public.loop_item USING btree (kind, status);

CREATE INDEX loop_item_number_idx ON public.loop_item USING btree (number);

CREATE UNIQUE INDEX loop_item_open_number_unique ON public.loop_item USING btree (kind, number) WHERE (status = 'open'::text);

CREATE INDEX loop_item_status_idx ON public.loop_item USING btree (status);

CREATE INDEX negotiation_claim_round_idx ON public.negotiation_claim USING btree (round_id);

CREATE INDEX negotiation_claim_type_idx ON public.negotiation_claim USING btree (claim_type);

CREATE INDEX next_action_deal_history_idx ON public.next_action USING btree (subject_id, created_at, id) WHERE (subject_type = 'deal'::text);

CREATE INDEX next_action_open_due_idx ON public.next_action USING btree (due_on, id) WHERE ((status = 'open'::text) AND (due_on IS NOT NULL));

CREATE UNIQUE INDEX one_open_next_action_per_owner ON public.next_action USING btree (subject_type, subject_id, owner_id) WHERE ((status = 'open'::text) AND (item_title IS NULL));

CREATE INDEX partner_room_turn_room_cursor ON public.partner_room_turn USING btree (room_id, id);

CREATE INDEX party_contact_state_idx ON public.party USING btree (contact_state);

CREATE INDEX party_directory_name_idx ON public.party USING btree (lower(name) COLLATE "C", id) WHERE ((merged_into IS NULL) AND (deleted_at IS NULL));

CREATE INDEX party_link_deal_referrer_idx ON public.party_link_deal USING btree (referred_by, deal_id);

CREATE INDEX party_link_from_idx ON public.party_link USING btree (from_party, kind);

CREATE UNIQUE INDEX party_link_from_to_kind_uidx ON public.party_link USING btree (from_party, to_party, kind);

CREATE INDEX party_link_to_idx ON public.party_link USING btree (to_party, kind);

CREATE INDEX party_link_via_idx ON public.party_link USING btree (via_party, kind);

CREATE INDEX party_merged_idx ON public.party USING btree (merged_into) WHERE (merged_into IS NOT NULL);

CREATE INDEX party_name_trgm ON public.party USING gin (name public.gin_trgm_ops);

CREATE UNIQUE INDEX party_org_identity_uniq ON public.party USING btree (public.org_identity_key(name)) WHERE ((kind = 'org'::text) AND (merged_into IS NULL) AND (deleted_at IS NULL) AND (public.org_identity_key(name) IS NOT NULL));

CREATE UNIQUE INDEX party_ref_uniq ON public.party USING btree (ref);

CREATE INDEX prospect_pool_county_idx ON public.candidate_pool USING btree (county);

CREATE INDEX prospect_pool_event_idx ON public.candidate_pool USING btree (est_lease_event) WHERE (est_lease_event IS NOT NULL);

CREATE INDEX prospect_pool_segment_idx ON public.candidate_pool USING btree (segment);

CREATE INDEX prospect_pool_source_idx ON public.candidate_pool USING btree (source, source_seq);

CREATE INDEX prospect_pool_status_idx ON public.candidate_pool USING btree (status);

CREATE INDEX record_flag_subject_idx ON public.record_flag USING btree (subject_type, subject_id, kind);

CREATE INDEX record_source_entity_idx ON public.record_source USING btree (entity_type, entity_id);

CREATE INDEX room_dispatch_link_session_idx ON public.room_dispatch_link USING btree (session_id, at DESC);

CREATE INDEX room_dispatch_link_turn_idx ON public.room_dispatch_link USING btree (turn_id);

CREATE UNIQUE INDEX rule_active_card_id ON public.rule USING btree (((card ->> 'id'::text))) WHERE ((status = 'active'::text) AND (card IS NOT NULL));

CREATE INDEX signal_event_queue_idx ON public.signal_event USING btree (status, severity, detected_at DESC);

CREATE INDEX signal_event_subject_idx ON public.signal_event USING btree (subject_type, subject_ref, detected_at DESC);

CREATE INDEX tool_call_correlation_idx ON public.tool_call USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);

CREATE INDEX tool_call_expiry_idx ON public.tool_call USING btree (created_at) WHERE (NOT ((verb = ANY (ARRAY['review-and-triage'::text, 'accept-ready-plan'::text, 'accept-outcome-feedback'::text])) OR (idempotency_key ~~ 'rw02-%'::text) OR (idempotency_key ~~ 'calcap-%'::text)));

CREATE INDEX vendor_category_slug_idx ON public.vendor USING btree (category_slug);

CREATE INDEX vendor_live_party_idx ON public.vendor USING btree (party_id, id) WHERE (merged_into IS NULL);

CREATE INDEX vendor_market_key_market ON public.vendor_market_key USING btree (market_slug);

CREATE INDEX vendor_market_membership_vendor ON public.vendor_market_membership USING btree (vendor_id);

CREATE INDEX vendor_merged_idx ON public.vendor USING btree (merged_into) WHERE (merged_into IS NOT NULL);

CREATE INDEX vendor_relationship_idx ON public.vendor USING btree (relationship_level, disposition);

CREATE OR REPLACE VIEW public.v_deal_room_session AS
 SELECT s.id AS session_id,
    s.workspace_kind,
    s.account_client_id,
    a.slug AS started_by,
    s.started_at,
    s.ended_at,
    s.status,
    s.summary,
    count(i.deal_id) FILTER (WHERE (i.disposition = 'reviewed'::text)) AS reviewed_count,
    count(i.deal_id) FILTER (WHERE (i.disposition = 'skipped'::text)) AS skipped_count
   FROM ((public.deal_review_session s
     JOIN public.actor a ON ((a.id = s.started_by)))
     LEFT JOIN public.deal_review_item i ON ((i.session_id = s.id)))
  GROUP BY s.id, a.slug;

CREATE TRIGGER activity_touch BEFORE UPDATE ON public.activity FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER agreement_touch BEFORE UPDATE ON public.agreement FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER allocation_tree BEFORE INSERT OR UPDATE OF parent_id, commission_id ON public.commission_allocation FOR EACH ROW EXECUTE FUNCTION public.enforce_allocation_tree();

CREATE TRIGGER availability_norm BEFORE INSERT OR UPDATE ON public.availability FOR EACH ROW EXECUTE FUNCTION public.trg_availability_norm();

CREATE TRIGGER building_touch BEFORE UPDATE ON public.building FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER campaign_channels_check BEFORE INSERT OR UPDATE OF channels ON public.campaign FOR EACH ROW EXECUTE FUNCTION public.campaign_channels_valid();

CREATE TRIGGER campaign_touch BEFORE UPDATE ON public.campaign FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER candidate_pool_confirm BEFORE INSERT OR UPDATE ON public.candidate_pool FOR EACH ROW EXECUTE FUNCTION public.carr_confirm_partner_touch();

CREATE TRIGGER capture_post_call_action_touch BEFORE UPDATE ON public.capture_post_call_action FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER client_touch BEFORE UPDATE ON public.client FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER commission_touch BEFORE UPDATE ON public.commission FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER critical_date_touch BEFORE UPDATE ON public.critical_date FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER deal_client_need_revision BEFORE UPDATE ON public.deal_client_need FOR EACH ROW EXECUTE FUNCTION public.revise_deal_client_need();

CREATE TRIGGER deal_participant_side BEFORE INSERT OR UPDATE OF role, actor_id, party_id ON public.deal_participant FOR EACH ROW EXECUTE FUNCTION public.trg_deal_participant_side();

CREATE TRIGGER deal_touch BEFORE UPDATE ON public.deal FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER doctrine_section_retrieval_repair_after_update AFTER UPDATE OF status ON public.doctrine_section FOR EACH ROW EXECUTE FUNCTION public.mark_retrieval_mappings_for_repair();

CREATE TRIGGER email_proposal_live_source BEFORE INSERT OR UPDATE ON public.email_proposal FOR EACH ROW EXECUTE FUNCTION public.guard_email_lifecycle_action();

CREATE TRIGGER event_email_touch_immutable BEFORE DELETE OR UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public.email_touch_application_immutable();

CREATE TRIGGER lead_touch BEFORE UPDATE ON public.lead FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER lease_touch BEFORE UPDATE ON public.lease FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER loop_block_touch BEFORE UPDATE ON public.loop_block FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER loop_item_confirm BEFORE INSERT OR UPDATE ON public.loop_item FOR EACH ROW EXECUTE FUNCTION public.carr_confirm_partner_touch();

CREATE TRIGGER loop_item_touch BEFORE UPDATE ON public.loop_item FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER negotiation_round_touch BEFORE UPDATE ON public.negotiation_round FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER next_action_confirm BEFORE INSERT OR UPDATE ON public.next_action FOR EACH ROW EXECUTE FUNCTION public.carr_confirm_partner_touch();

CREATE TRIGGER next_action_touch BEFORE UPDATE ON public.next_action FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER party_touch BEFORE UPDATE ON public.party FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER prospect_pool_touch BEFORE UPDATE ON public.candidate_pool FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER rule_touch BEFORE UPDATE ON public.rule FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER space_touch BEFORE UPDATE ON public.space FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

CREATE TRIGGER tool_call_expire BEFORE INSERT ON public.tool_call FOR EACH ROW EXECUTE FUNCTION public.tool_call_expire();

CREATE TRIGGER vendor_market_canonical_key AFTER INSERT ON public.vendor_market FOR EACH ROW EXECUTE FUNCTION public.vendor_market_canonical_key();

CREATE TRIGGER vendor_touch BEFORE UPDATE ON public.vendor FOR EACH ROW EXECUTE FUNCTION public.trg_touch_row();

ALTER TABLE ONLY ops.client_portal
    ADD CONSTRAINT client_portal_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY ops.client_portal
    ADD CONSTRAINT client_portal_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_evidence_attachment_id_fkey FOREIGN KEY (evidence_attachment_id) REFERENCES public.attachment(id);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_fulfilled_by_fkey FOREIGN KEY (fulfilled_by) REFERENCES public.actor(id);

ALTER TABLE ONLY ops.requirement_request
    ADD CONSTRAINT requirement_request_thread_activity_id_fkey FOREIGN KEY (thread_activity_id) REFERENCES public.activity(id);

ALTER TABLE ONLY ops.requirement_upload_receipt
    ADD CONSTRAINT requirement_upload_receipt_grant_id_request_id_fkey FOREIGN KEY (grant_id, request_id) REFERENCES ops.requirement_upload_grant(id, request_id);

ALTER TABLE ONLY ops.requirement_upload_receipt
    ADD CONSTRAINT requirement_upload_receipt_request_id_fkey FOREIGN KEY (request_id) REFERENCES ops.requirement_request(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_client_fk FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_deal_fk FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_kind_fkey FOREIGN KEY (kind) REFERENCES public.activity_kind(slug);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_lead_fk FOREIGN KEY (lead_id) REFERENCES public.lead(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_party_fk FOREIGN KEY (party_id) REFERENCES public.party(id) NOT VALID;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_vendor_fk FOREIGN KEY (vendor_id) REFERENCES public.vendor(id);

ALTER TABLE ONLY public.agreement
    ADD CONSTRAINT agreement_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.agreement
    ADD CONSTRAINT agreement_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.agreement
    ADD CONSTRAINT agreement_doc_fk FOREIGN KEY (doc_attachment) REFERENCES public.attachment(id);

ALTER TABLE ONLY public.agreement
    ADD CONSTRAINT agreement_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT allocation_parent_same_commission FOREIGN KEY (parent_id, commission_id) REFERENCES public.commission_allocation(id, commission_id);

ALTER TABLE ONLY public.attachment
    ADD CONSTRAINT attachment_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.space(id);

ALTER TABLE ONLY public.building
    ADD CONSTRAINT building_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.building
    ADD CONSTRAINT building_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.building(id);

ALTER TABLE ONLY public.building_ownership
    ADD CONSTRAINT building_ownership_building_id_fkey FOREIGN KEY (building_id) REFERENCES public.building(id);

ALTER TABLE ONLY public.building_ownership
    ADD CONSTRAINT building_ownership_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.building_ownership
    ADD CONSTRAINT building_ownership_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.building
    ADD CONSTRAINT building_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.parcel(id);

ALTER TABLE ONLY public.building
    ADD CONSTRAINT building_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.campaign
    ADD CONSTRAINT campaign_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.campaign
    ADD CONSTRAINT campaign_scored_by_fkey FOREIGN KEY (scored_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.campaign
    ADD CONSTRAINT campaign_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT candidate_pool_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT candidate_pool_declined_by_fkey FOREIGN KEY (declined_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_candidate
    ADD CONSTRAINT capture_candidate_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_candidate
    ADD CONSTRAINT capture_candidate_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.capture_session(id);

ALTER TABLE ONLY public.capture_candidate
    ADD CONSTRAINT capture_candidate_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.capture_post_call_candidate(id);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.capture_post_call_action
    ADD CONSTRAINT capture_post_call_action_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_contact_party_id_fkey FOREIGN KEY (contact_party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_recipient_party_id_fkey FOREIGN KEY (recipient_party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_post_call_candidate
    ADD CONSTRAINT capture_post_call_candidate_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.capture_session(id);

ALTER TABLE ONLY public.capture_session
    ADD CONSTRAINT capture_session_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.capture_session
    ADD CONSTRAINT capture_session_outcome_reviewed_by_fkey FOREIGN KEY (outcome_reviewed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_client_type_fkey FOREIGN KEY (client_type) REFERENCES public.client_type(slug);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.client(id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_status_fkey FOREIGN KEY (status) REFERENCES public.client_status(slug);

ALTER TABLE ONLY public.client
    ADD CONSTRAINT client_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT commission_allocation_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT commission_allocation_commission_id_fkey FOREIGN KEY (commission_id) REFERENCES public.commission(id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT commission_allocation_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.commission_allocation(id);

ALTER TABLE ONLY public.commission_allocation
    ADD CONSTRAINT commission_allocation_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.commission
    ADD CONSTRAINT commission_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.commission
    ADD CONSTRAINT commission_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.commission
    ADD CONSTRAINT commission_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.comp
    ADD CONSTRAINT comp_building_id_fkey FOREIGN KEY (building_id) REFERENCES public.building(id);

ALTER TABLE ONLY public.comp
    ADD CONSTRAINT comp_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.comp
    ADD CONSTRAINT comp_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.space(id);

ALTER TABLE ONLY public.critical_date
    ADD CONSTRAINT critical_date_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.critical_date
    ADD CONSTRAINT critical_date_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.critical_date
    ADD CONSTRAINT critical_date_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_approved_client_id_fkey FOREIGN KEY (approved_client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_client_need
    ADD CONSTRAINT deal_client_need_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendor(id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_actor_a_fkey FOREIGN KEY (actor_a) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_actor_b_fkey FOREIGN KEY (actor_b) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_event_a_fkey FOREIGN KEY (event_a) REFERENCES public.event(id);

ALTER TABLE ONLY public.deal_conflict
    ADD CONSTRAINT deal_conflict_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_deal_type_fkey FOREIGN KEY (deal_type) REFERENCES public.deal_type_ref(slug);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_invoice_event_id_fkey FOREIGN KEY (invoice_event_id) REFERENCES public.event(id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_phase_event_id_fkey FOREIGN KEY (phase_event_id) REFERENCES public.event(id);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_prior_phase_fkey FOREIGN KEY (prior_phase) REFERENCES public.deal_phase(slug);

ALTER TABLE ONLY public.deal_invoice_email
    ADD CONSTRAINT deal_invoice_email_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_lane_fkey FOREIGN KEY (lane) REFERENCES public.deal_lane(slug);

ALTER TABLE ONLY public.deal_market_assignment
    ADD CONSTRAINT deal_market_assignment_agent_party_id_fkey FOREIGN KEY (agent_party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.deal_market_assignment
    ADD CONSTRAINT deal_market_assignment_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_market_assignment
    ADD CONSTRAINT deal_market_assignment_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_note
    ADD CONSTRAINT deal_note_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_note
    ADD CONSTRAINT deal_note_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_owner_fkey FOREIGN KEY (owner) REFERENCES public.actor(slug);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_parked_by_fkey FOREIGN KEY (parked_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_role_fkey FOREIGN KEY (role) REFERENCES public.participant_role(slug);

ALTER TABLE ONLY public.deal_participant
    ADD CONSTRAINT deal_participant_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_phase_fkey FOREIGN KEY (phase) REFERENCES public.deal_phase(slug);

ALTER TABLE ONLY public.deal_presence_lease
    ADD CONSTRAINT deal_presence_lease_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_presence_lease
    ADD CONSTRAINT deal_presence_lease_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_reattach_log
    ADD CONSTRAINT deal_reattach_log_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_reattach_log
    ADD CONSTRAINT deal_reattach_log_from_client_fkey FOREIGN KEY (from_client) REFERENCES public.client(id);

ALTER TABLE ONLY public.deal_reattach_log
    ADD CONSTRAINT deal_reattach_log_to_client_fkey FOREIGN KEY (to_client) REFERENCES public.client(id);

ALTER TABLE ONLY public.deal_review_item
    ADD CONSTRAINT deal_review_item_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_review_item
    ADD CONSTRAINT deal_review_item_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.deal_review_session(id);

ALTER TABLE ONLY public.deal_review_session
    ADD CONSTRAINT deal_review_session_account_client_id_fkey FOREIGN KEY (account_client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.deal_review_session
    ADD CONSTRAINT deal_review_session_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal
    ADD CONSTRAINT deal_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_company_party_id_fkey FOREIGN KEY (company_party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_contact_party_id_fkey FOREIGN KEY (contact_party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.deal_vendor_assignment
    ADD CONSTRAINT deal_vendor_assignment_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doc_template
    ADD CONSTRAINT doc_template_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_change_set
    ADD CONSTRAINT doctrine_change_set_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_change_set
    ADD CONSTRAINT doctrine_change_set_gate_fk FOREIGN KEY (gate_run_id) REFERENCES public.doctrine_gate_run(id);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.retrieval_concept(id);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_proposer_id_fkey FOREIGN KEY (proposer_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_concept_mapping
    ADD CONSTRAINT doctrine_concept_mapping_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.doctrine_section(id);

ALTER TABLE ONLY public.doctrine_document
    ADD CONSTRAINT doctrine_document_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_document
    ADD CONSTRAINT doctrine_document_owner_actor_id_fkey FOREIGN KEY (owner_actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_document
    ADD CONSTRAINT doctrine_document_review_fk FOREIGN KEY (review_policy_id) REFERENCES public.doctrine_review_policy(id);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_edge_type_fkey FOREIGN KEY (edge_type) REFERENCES public.doctrine_edge_type(edge_type);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_introduced_by_revision_id_fkey FOREIGN KEY (introduced_by_revision_id) REFERENCES public.doctrine_revision(id);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_retired_by_revision_id_fkey FOREIGN KEY (retired_by_revision_id) REFERENCES public.doctrine_revision(id);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_source_section_id_fkey FOREIGN KEY (source_section_id) REFERENCES public.doctrine_section(id);

ALTER TABLE ONLY public.doctrine_edge
    ADD CONSTRAINT doctrine_edge_target_section_id_fkey FOREIGN KEY (target_section_id) REFERENCES public.doctrine_section(id);

ALTER TABLE ONLY public.doctrine_gate_run
    ADD CONSTRAINT doctrine_gate_run_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_gate_run
    ADD CONSTRAINT doctrine_gate_run_change_set_id_fkey FOREIGN KEY (change_set_id) REFERENCES public.doctrine_change_set(id);

ALTER TABLE ONLY public.doctrine_link
    ADD CONSTRAINT doctrine_link_source_section_id_fkey FOREIGN KEY (source_section_id) REFERENCES public.doctrine_section(id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_change_set_id_fkey FOREIGN KEY (change_set_id) REFERENCES public.doctrine_change_set(id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_parent_revision_id_fkey FOREIGN KEY (parent_revision_id) REFERENCES public.doctrine_revision(id);

ALTER TABLE ONLY public.doctrine_revision
    ADD CONSTRAINT doctrine_revision_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.doctrine_section(id);

ALTER TABLE ONLY public.doctrine_section
    ADD CONSTRAINT doctrine_section_current_rev_fk FOREIGN KEY (current_revision_id) REFERENCES public.doctrine_revision(id);

ALTER TABLE ONLY public.doctrine_section
    ADD CONSTRAINT doctrine_section_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.doctrine_document(id);

ALTER TABLE ONLY public.doctrine_slug_alias
    ADD CONSTRAINT doctrine_slug_alias_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.doctrine_document(id);

ALTER TABLE ONLY public.doctrine_snapshot
    ADD CONSTRAINT doctrine_snapshot_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.doctrine_document(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_pdf_fk FOREIGN KEY (pdf_attachment) REFERENCES public.attachment(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_prepared_by_fkey FOREIGN KEY (prepared_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.doc_template(id);

ALTER TABLE ONLY public.document
    ADD CONSTRAINT document_working_fk FOREIGN KEY (working_attachment) REFERENCES public.attachment(id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activity(id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.email_proposal
    ADD CONSTRAINT email_proposal_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.event
    ADD CONSTRAINT event_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.lead(id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead_contact_draft
    ADD CONSTRAINT lead_contact_draft_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_lane_fkey FOREIGN KEY (lane) REFERENCES public.lead_lane(slug);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_stage_fkey FOREIGN KEY (stage) REFERENCES public.lead_stage(slug);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.activity(id);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_from_stage_fkey FOREIGN KEY (from_stage) REFERENCES public.lead_stage(slug);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.lead(id);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_to_stage_fkey FOREIGN KEY (to_stage) REFERENCES public.lead_stage(slug);

ALTER TABLE ONLY public.lead_stage_move
    ADD CONSTRAINT lead_stage_move_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT lead_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_doc_fk FOREIGN KEY (doc_attachment) REFERENCES public.attachment(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_premises_id_fkey FOREIGN KEY (premises_id) REFERENCES public.premises(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_supersedes_lease_id_fkey FOREIGN KEY (supersedes_lease_id) REFERENCES public.lease(id);

ALTER TABLE ONLY public.lease
    ADD CONSTRAINT lease_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_block
    ADD CONSTRAINT loop_block_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_block
    ADD CONSTRAINT loop_block_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.loop_block(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_domain_fkey FOREIGN KEY (domain) REFERENCES public.loop_domain(slug);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_personal_to_fkey FOREIGN KEY (personal_to) REFERENCES public.actor(id);

ALTER TABLE ONLY public.loop_item
    ADD CONSTRAINT loop_item_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.marketing_subject
    ADD CONSTRAINT marketing_subject_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.national_account_owner
    ADD CONSTRAINT national_account_owner_account_client_id_fkey FOREIGN KEY (account_client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.national_account_owner
    ADD CONSTRAINT national_account_owner_owner_actor_id_fkey FOREIGN KEY (owner_actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.national_account_owner
    ADD CONSTRAINT national_account_owner_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.negotiation_claim
    ADD CONSTRAINT negotiation_claim_claim_type_loggable_fkey FOREIGN KEY (claim_type, loggable) REFERENCES public.negotiation_claim_type(slug, derived);

ALTER TABLE ONLY public.negotiation_claim
    ADD CONSTRAINT negotiation_claim_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.negotiation_claim
    ADD CONSTRAINT negotiation_claim_round_id_fkey FOREIGN KEY (round_id) REFERENCES public.negotiation_round(id);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_submarket_condition_fkey FOREIGN KEY (submarket_condition) REFERENCES public.submarket_condition(slug);

ALTER TABLE ONLY public.negotiation_round
    ADD CONSTRAINT negotiation_round_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.next_action
    ADD CONSTRAINT next_action_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.next_action
    ADD CONSTRAINT next_action_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.next_action
    ADD CONSTRAINT next_action_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.next_action
    ADD CONSTRAINT next_action_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_contact_state_fkey FOREIGN KEY (contact_state) REFERENCES public.contact_state(slug);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_contact_state_set_by_fkey FOREIGN KEY (contact_state_set_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.party_link_deal
    ADD CONSTRAINT party_link_deal_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.party_link_deal
    ADD CONSTRAINT party_link_deal_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.party_link_deal
    ADD CONSTRAINT party_link_deal_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.party_link(id);

ALTER TABLE ONLY public.party_link_deal
    ADD CONSTRAINT party_link_deal_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES public.party(id);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_from_party_fkey FOREIGN KEY (from_party) REFERENCES public.party(id);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_kind_fkey FOREIGN KEY (kind) REFERENCES public.party_link_kind(slug);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_to_party_fkey FOREIGN KEY (to_party) REFERENCES public.party(id);

ALTER TABLE ONLY public.party_link
    ADD CONSTRAINT party_link_via_party_fkey FOREIGN KEY (via_party) REFERENCES public.party(id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.party(id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.party
    ADD CONSTRAINT party_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.premises
    ADD CONSTRAINT premises_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.premises
    ADD CONSTRAINT premises_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.premises_space
    ADD CONSTRAINT premises_space_premises_id_fkey FOREIGN KEY (premises_id) REFERENCES public.premises(id);

ALTER TABLE ONLY public.premises_space
    ADD CONSTRAINT premises_space_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.space(id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT prospect_pool_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT prospect_pool_promoted_lead_id_fkey FOREIGN KEY (promoted_lead_id) REFERENCES public.lead(id);

ALTER TABLE ONLY public.candidate_pool
    ADD CONSTRAINT prospect_pool_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.record_flag
    ADD CONSTRAINT record_flag_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_doc_fk FOREIGN KEY (doc_attachment) REFERENCES public.attachment(id);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_premises_id_fkey FOREIGN KEY (premises_id) REFERENCES public.premises(id);

ALTER TABLE ONLY public.registration
    ADD CONSTRAINT registration_registered_with_party_fkey FOREIGN KEY (registered_with_party) REFERENCES public.party(id);

ALTER TABLE ONLY public.retrieval_concept
    ADD CONSTRAINT retrieval_concept_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.retrieval_concept
    ADD CONSTRAINT retrieval_concept_proposer_id_fkey FOREIGN KEY (proposer_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.room_dispatch_link
    ADD CONSTRAINT room_dispatch_link_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.partner_room_turn(id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_personal_to_fkey FOREIGN KEY (personal_to) REFERENCES public.actor(id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_supersedes_fkey FOREIGN KEY (supersedes) REFERENCES public.rule(id);

ALTER TABLE ONLY public.rule
    ADD CONSTRAINT rule_taught_by_fkey FOREIGN KEY (taught_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.signal_event
    ADD CONSTRAINT signal_event_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.space
    ADD CONSTRAINT space_building_id_fkey FOREIGN KEY (building_id) REFERENCES public.building(id);

ALTER TABLE ONLY public.space
    ADD CONSTRAINT space_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.space_search
    ADD CONSTRAINT space_search_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client(id);

ALTER TABLE ONLY public.space_search
    ADD CONSTRAINT space_search_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.space_search
    ADD CONSTRAINT space_search_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deal(id);

ALTER TABLE ONLY public.space
    ADD CONSTRAINT space_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_updated_by_fk FOREIGN KEY (updated_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.tool_call
    ADD CONSTRAINT tool_call_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_category_slug_fkey FOREIGN KEY (category_slug) REFERENCES public.vendor_category(slug);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_disposition_fkey FOREIGN KEY (disposition) REFERENCES public.vendor_disposition(slug);

ALTER TABLE ONLY public.vendor_market_key
    ADD CONSTRAINT vendor_market_key_market_slug_fkey FOREIGN KEY (market_slug) REFERENCES public.vendor_market(slug);

ALTER TABLE ONLY public.vendor_market_membership
    ADD CONSTRAINT vendor_market_membership_market_slug_fkey FOREIGN KEY (market_slug) REFERENCES public.vendor_market(slug);

ALTER TABLE ONLY public.vendor_market_membership
    ADD CONSTRAINT vendor_market_membership_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor_market_membership
    ADD CONSTRAINT vendor_market_membership_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendor(id);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_referen_regional_slug_regional_kind_fkey FOREIGN KEY (regional_slug, regional_kind) REFERENCES public.vendor_market(slug, kind);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_reference_market_slug_fkey FOREIGN KEY (market_slug) REFERENCES public.vendor_market(slug);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_reference_market_slug_market_kind_fkey FOREIGN KEY (market_slug, market_kind) REFERENCES public.vendor_market(slug, kind);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_reference_regional_slug_fkey FOREIGN KEY (regional_slug) REFERENCES public.vendor_market(slug);

ALTER TABLE ONLY public.vendor_market_regional_reference
    ADD CONSTRAINT vendor_market_regional_reference_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor_market
    ADD CONSTRAINT vendor_market_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.vendor(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.actor(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.party(id);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_relationship_level_fkey FOREIGN KEY (relationship_level) REFERENCES public.vendor_relationship_level(level);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_stage_fkey FOREIGN KEY (stage) REFERENCES public.vendor_stage(slug);

ALTER TABLE ONLY public.vendor
    ADD CONSTRAINT vendor_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.actor(id);
