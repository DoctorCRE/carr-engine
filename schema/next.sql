-- The new database's core, designed in docs/new-database.md. Nothing applies it to a live database.
-- It names no schema, so a loader chooses the namespace with search_path.

create table party (
	id uuid primary key default gen_random_uuid(),
	kind text not null check (kind in ('person', 'company')),
	name text not null,
	unique (id, kind)
);

create table role (
	slug text primary key,
	label text not null
);

create table party_role (
	party_id uuid not null references party,
	role text not null references role,
	primary key (party_id, role)
);

-- A person's place at a company, dated, so their history survives a move.
create table party_company (
	id uuid primary key default gen_random_uuid(),
	person_id uuid not null,
	person_kind text not null generated always as ('person') stored,
	company_id uuid not null,
	company_kind text not null generated always as ('company') stored,
	title text,
	started_on date,
	ended_on date check (ended_on >= started_on),
	unique nulls not distinct (person_id, company_id, started_on),
	foreign key (person_id, person_kind) references party (id, kind),
	foreign key (company_id, company_kind) references party (id, kind)
);

create table property (
	id uuid primary key default gen_random_uuid(),
	address text not null
);

create table deal (
	id uuid primary key default gen_random_uuid(),
	name text not null
);

create table phase (
	slug text primary key,
	label text not null
);

create table deal_phase_change (
	deal_id uuid not null references deal,
	changed_at timestamptz not null,
	phase text not null references phase,
	reason text,
	primary key (deal_id, changed_at),
	constraint deal_phase_change_dead_has_reason check (phase <> 'dead' or reason is not null)
);

create table deal_property (
	deal_id uuid not null references deal,
	property_id uuid not null references property,
	primary key (deal_id, property_id)
);

create table deal_party (
	deal_id uuid not null references deal,
	party_id uuid not null references party,
	role text not null references role,
	primary key (deal_id, party_id, role)
);

create table activity (
	id uuid primary key default gen_random_uuid(),
	kind text not null check (kind in ('email', 'call', 'meeting', 'note')),
	happened_at timestamptz not null,
	from_party_id uuid references party,
	summary text,
	unique (id, kind)
);

create table activity_about (
	activity_id uuid not null references activity,
	deal_id uuid references deal,
	party_id uuid references party,
	property_id uuid references property,
	constraint activity_about_one_record check (num_nonnulls(deal_id, party_id, property_id) = 1),
	unique nulls not distinct (activity_id, deal_id, party_id, property_id)
);

-- Only the new text is kept; the date is the activity's, and the mailbox stays the full record.
create table email (
	activity_id uuid primary key,
	activity_kind text not null generated always as ('email') stored,
	message_id text not null unique check (message_id = btrim(message_id)),
	sender text not null,
	subject text not null,
	body text not null,
	foreign key (activity_id, activity_kind) references activity (id, kind)
);

create function email_about_a_record() returns trigger
language plpgsql as $$
declare
	wanted uuid := case tg_table_name when 'email' then new.activity_id else old.activity_id end;
begin
	if exists (select from email where activity_id = wanted)
		and not exists (select from activity_about where activity_id = wanted) then
		raise exception 'an email is stored only when it is about a record'
			using errcode = 'check_violation', constraint = 'email_about_a_record';
	end if;
	return null;
end $$;

-- Deferred, because an email is saved before the rows that say what it is about.
create constraint trigger email_about_a_record after insert or update of activity_id on email
	initially deferred for each row execute function email_about_a_record();
create constraint trigger email_about_a_record after delete or update of activity_id on activity_about
	initially deferred for each row execute function email_about_a_record();

create function email_about_a_record_on_truncate() returns trigger
language plpgsql as $$
begin
	if exists (select from email) then
		raise exception 'an email is stored only when it is about a record'
			using errcode = 'check_violation', constraint = 'email_about_a_record';
	end if;
	return null;
end $$;

-- Row and constraint triggers do not fire on truncate.
create trigger email_about_a_record_on_truncate after truncate on activity_about
	for each statement execute function email_about_a_record_on_truncate();

create table next_step (
	id uuid primary key default gen_random_uuid(),
	what text not null,
	-- No owner also covers a partner's own step, until partners become parties.
	owner_party_id uuid references party,
	due_on date,
	done_at timestamptz,
	deal_id uuid references deal,
	party_id uuid references party,
	property_id uuid references property,
	constraint next_step_one_record check (num_nonnulls(deal_id, party_id, property_id) = 1)
);

create table document (
	id uuid primary key default gen_random_uuid(),
	name text not null,
	r2_key text not null,
	email_activity_id uuid references email
);

create table offer (
	id uuid primary key default gen_random_uuid(),
	deal_id uuid not null,
	property_id uuid not null,
	round smallint not null check (round >= 1),
	answers_round smallint,
	from_party_id uuid not null,
	from_role text not null,
	offered_at timestamptz not null,
	status text not null default 'open'
		check (status in ('open', 'countered', 'accepted', 'rejected', 'withdrawn', 'superseded')),
	rent_per_sf_yr numeric(10, 2) check (rent_per_sf_yr >= 0),
	nnn_per_sf_yr numeric(10, 2) check (nnn_per_sf_yr >= 0),
	term_months integer check (term_months >= 0),
	ti_per_sf numeric(10, 2) check (ti_per_sf >= 0),
	free_rent_months numeric(4, 1) check (free_rent_months >= 0),
	escalation_pct numeric(5, 2) check (escalation_pct >= 0),
	commencement_on date,
	commencement_days_after_delivery integer check (commencement_days_after_delivery >= 0),
	other_terms text,
	constraint offer_answers_earlier_round check (answers_round < round),
	constraint offer_commencement_date_or_days
		check (commencement_on is null or commencement_days_after_delivery is null),
	unique (deal_id, round),
	foreign key (deal_id, property_id) references deal_property,
	foreign key (deal_id, from_party_id, from_role) references deal_party,
	foreign key (deal_id, answers_round) references offer (deal_id, round)
);

-- An earlier accepted round is superseded before a revived deal accepts a new one.
create unique index offer_one_accepted_per_deal on offer (deal_id) where status = 'accepted';

-- Refuses removing a row or changing it, except in the columns the trigger names.
create function keeps_history() returns trigger
language plpgsql as $$
declare
	-- tg_argv is null, not empty, when the trigger names no columns.
	changeable text[] := coalesce(tg_argv, '{}');
begin
	if tg_op <> 'UPDATE' or to_jsonb(new) - changeable <> to_jsonb(old) - changeable then
		raise exception '% is history: never rewritten or removed', tg_table_name
			using errcode = 'check_violation', constraint = tg_table_name || '_keeps_history';
	end if;
	return new;
end $$;

create trigger offer_keeps_history before update or delete on offer
	for each row execute function keeps_history('status');
-- Row triggers do not fire on truncate.
create trigger offer_keeps_history_on_truncate before truncate on offer
	for each statement execute function keeps_history();

create trigger deal_phase_change_keeps_history before update or delete on deal_phase_change
	for each row execute function keeps_history();
create trigger deal_phase_change_keeps_history_on_truncate before truncate on deal_phase_change
	for each statement execute function keeps_history();

create function offer_status_moves() returns trigger
language plpgsql as $$
begin
	if not (old.status = 'open' and new.status <> 'superseded'
		or old.status = 'accepted' and new.status = 'superseded') then
		raise exception 'a round''s status moves only out of open, or from accepted to superseded'
			using errcode = 'check_violation', constraint = 'offer_status_moves';
	end if;
	return new;
end $$;

create trigger offer_status_moves before update of status on offer
	for each row when (new.status is distinct from old.status) execute function offer_status_moves();

create function offer_superseded_by_later_acceptance() returns trigger
language plpgsql as $$
begin
	if not exists (
		select from offer
		where deal_id = new.deal_id and round > new.round and status = 'accepted'
	) then
		raise exception 'a round is superseded only when a later round of its deal is accepted'
			using errcode = 'check_violation', constraint = 'offer_superseded_by_later_acceptance';
	end if;
	return null;
end $$;

-- Deferred, because the earlier round is superseded before the later one can be accepted.
create constraint trigger offer_superseded_by_later_acceptance after insert or update of status on offer
	initially deferred for each row when (new.status = 'superseded')
	execute function offer_superseded_by_later_acceptance();

create table offer_document (
	offer_id uuid not null references offer,
	document_id uuid not null references document,
	primary key (offer_id, document_id)
);

-- A truncate cascading from email through document would otherwise reach a round's documents.
create trigger offer_document_keeps_history_on_truncate before truncate on offer_document
	for each statement execute function keeps_history();

create function everything_about_deal(wanted uuid) returns jsonb
language sql stable
begin atomic
	select jsonb_build_object(
		'deal', to_jsonb(d),
		'phases', (
			select coalesce(jsonb_agg(to_jsonb(c) - 'deal_id' order by c.changed_at), '[]')
			from deal_phase_change c
			where c.deal_id = d.id
		),
		'properties', (
			select coalesce(jsonb_agg(to_jsonb(p) order by p.address), '[]')
			from deal_property dp join property p on p.id = dp.property_id
			where dp.deal_id = d.id
		),
		'parties', (
			select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('role', dp.role) order by dp.role, p.name), '[]')
			from deal_party dp join party p on p.id = dp.party_id
			where dp.deal_id = d.id
		),
		'offers', (
			select coalesce(jsonb_agg(to_jsonb(o) - 'deal_id' || jsonb_build_object('documents', (
				select coalesce(jsonb_agg(to_jsonb(doc) order by doc.name, doc.id), '[]')
				from offer_document od join document doc on doc.id = od.document_id
				where od.offer_id = o.id
			)) order by o.round), '[]')
			from offer o
			where o.deal_id = d.id
		),
		'activity', (
			select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object('email', (
				select to_jsonb(e) - 'activity_id' - 'activity_kind' || jsonb_build_object('documents', (
					select coalesce(jsonb_agg(to_jsonb(doc) order by doc.name, doc.id), '[]')
					from document doc
					where doc.email_activity_id = e.activity_id
				))
				from email e
				where e.activity_id = a.id
			)) order by a.happened_at, a.id), '[]')
			from activity_about aa join activity a on a.id = aa.activity_id
			where aa.deal_id = d.id
		),
		'next_steps', (
			select coalesce(jsonb_agg(to_jsonb(s) - 'deal_id' - 'party_id' - 'property_id'
				order by s.due_on nulls last, s.id), '[]')
			from next_step s
			where s.deal_id = d.id
		)
	)
	from deal d
	where d.id = wanted;
end;
