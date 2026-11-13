-- The new database's core, designed in docs/new-database.md. Nothing applies it to a live database.
-- It names no schema, so a loader chooses the namespace with search_path.

create table party (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
	primary key (party_id, role)
);

-- A person's place at a company, dated, so their history survives a move.
create table party_company (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
	address text not null
);

create table deal (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
	primary key (deal_id, property_id)
);

create table deal_party (
	deal_id uuid not null references deal,
	party_id uuid not null references party,
	role text not null references role,
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
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
create constraint trigger email_about_a_record after insert on email
	initially deferred for each row execute function email_about_a_record();
create constraint trigger email_about_a_record after delete on activity_about
	initially deferred for each row execute function email_about_a_record();

create table next_step (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
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
	created_at timestamptz not null default now(),
	primary key (offer_id, document_id)
);

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

-- "Account" alone means a national account (docs/glossary.md).
create table social_account (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
	platform text not null check (platform in ('x', 'linkedin', 'facebook', 'instagram')),
	owner_party_id uuid not null references party,
	handle text not null check (handle ~ '\S'),
	unique (id, platform)
);

-- Platforms ignore case in handles.
create unique index social_account_one_per_handle on social_account (platform, lower(handle));

-- The seed is a guess until checked against each platform's API.
create table platform_metric (
	platform text not null check (platform in ('x', 'linkedin', 'facebook', 'instagram')),
	metric text not null
		check (metric in ('views', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'follows')),
	-- Day 7 asks this metric only of posts published since, so adding one keeps older posts compared.
	reported_since timestamptz not null default now(),
	primary key (platform, metric)
);

insert into platform_metric
select platform, unnest(metrics), '-infinity' from (values
	('x', array['views', 'reactions', 'comments', 'shares', 'clicks', 'follows']),
	('linkedin', array['views', 'reactions', 'comments', 'shares', 'clicks', 'follows']),
	('facebook', array['views', 'reactions', 'comments', 'shares', 'clicks']),
	('instagram', array['views', 'reactions', 'comments', 'shares', 'saves', 'follows'])
) as reported (platform, metrics);

create table idea (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
	angle text not null,
	hook text not null,
	pillar text not null
);

create table design_template (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
	name text not null unique
);

create table post (
	id uuid primary key default gen_random_uuid(),
	social_account_id uuid not null,
	platform text not null,
	idea_id uuid references idea,
	design_template_id uuid references design_template,
	scheduled_at timestamptz not null,
	status text not null default 'scheduled' check (status in ('scheduled', 'published', 'failed')),
	platform_post_id text,
	published_at timestamptz,
	constraint post_published_has_id_and_time
		check (num_nonnulls(platform_post_id, published_at) = case status when 'published' then 2 else 0 end),
	unique (social_account_id, platform_post_id),
	unique (id, platform),
	foreign key (social_account_id, platform) references social_account (id, platform)
);

create function post_final() returns trigger
language plpgsql as $$
begin
	raise exception 'a published or failed post never changes'
		using errcode = 'check_violation', constraint = 'post_final';
end $$;

-- A retry is a new post, so a failure stays on record, and a published post keeps the time its readings count from.
create trigger post_final before update on post
	for each row when (old.status <> 'scheduled' and old.* is distinct from new.*) execute function post_final();

create table measurement (
	post_id uuid not null,
	platform text not null,
	metric text not null,
	taken_at timestamptz not null,
	source text not null check (source ~ '\S'),
	value bigint check (value >= 0),
	not_measured_reason text check (not_measured_reason ~ '\S'),
	constraint measurement_value_or_reason check (num_nonnulls(value, not_measured_reason) = 1),
	primary key (post_id, metric, taken_at, source),
	foreign key (post_id, platform) references post (id, platform),
	foreign key (platform, metric) references platform_metric
);

-- Checked on insert only: a reading is never rewritten, and a published post never changes.
create function measurement_after_publishing() returns trigger
language plpgsql as $$
begin
	if not exists (select from post where id = new.post_id and published_at <= new.taken_at) then
		raise exception 'a reading is of a published post, taken no earlier than it was published'
			using errcode = 'check_violation', constraint = 'measurement_after_publishing';
	end if;
	return new;
end $$;

create trigger measurement_after_publishing before insert on measurement
	for each row execute function measurement_after_publishing();

create function posts_at_day_7(as_of timestamptz) returns jsonb
language sql stable
begin atomic
	with day_7 as (
		select distinct on (p.id, r.metric) p.*, r.metric, m.value, m.taken_at
		from post p
		join platform_metric r on r.platform = p.platform
			and r.metric in ('views', 'reactions', 'comments', 'shares', 'saves')
			and r.reported_since <= p.published_at
		-- Hours, not days, so the session's time zone cannot move day 7 across a clock change.
		left join measurement m on m.post_id = p.id and m.metric = r.metric
			and m.taken_at <= p.published_at + interval '168 hours'
		where p.published_at + interval '168 hours' <= as_of
		order by p.id, r.metric, m.taken_at desc, m.value is null, m.source
	),
	compared as (
		select id, social_account_id, idea_id, design_template_id, published_at,
			sum(value) filter (where metric <> 'views') / max(value) filter (where metric = 'views')
				as engagement_per_view,
			-- The oldest reading used: under 168 shows the post was judged before day 7.
			round(extract(epoch from min(taken_at) - published_at) / 3600, 1) as reading_age_hours
		from day_7
		group by id, social_account_id, idea_id, design_template_id, published_at
		-- A reported metric missing or not measured at day 7 leaves the post out; it never counts as zero.
		having count(value) = count(*) and max(value) filter (where metric = 'views') > 0
	),
	ranked as (
		select social_account_id, count(*) as posts,
			jsonb_agg(c order by engagement_per_view desc, id) -> 0 as best,
			jsonb_agg(c order by engagement_per_view, id) -> 0 as worst
		from (
			select id, social_account_id, published_at, idea_id, design_template_id,
				round(engagement_per_view, 4) as engagement_per_view, reading_age_hours
			from compared
		) c
		group by social_account_id
	)
	select jsonb_build_object(
		'accounts', (
			select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
				'posts', r.posts, 'best', r.best - 'social_account_id', 'worst', r.worst - 'social_account_id'
			) order by a.platform, a.handle), '[]')
			from social_account a join ranked r on r.social_account_id = a.id
		)
	);
end;

-- The engine's role. A login takes it with "grant engine to <login>"; the owner's own login is not the engine's concern.
-- It reads everywhere, adds everywhere but platform_metric, never empties a table, and changes or removes only what the grants below name.
-- History (deal_phase_change, offer, offer_document, post, measurement) is never removed.
do $$ begin
	begin
		create role engine nologin;
	-- Roles belong to the server and outlive a database, so a second load reuses it.
	exception when duplicate_object or unique_violation then null;
	end;
	-- A reused role must hold nothing that would reach past the grants below.
	if exists (select from pg_roles where rolname = 'engine'
			and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
		or exists (select from pg_auth_members where member = 'engine'::regrole) then
		raise exception 'role engine holds rights beyond its grants';
	end if;
end $$;

do $$ begin
	execute format('grant usage on schema %1$I to engine;
		grant select, insert on all tables in schema %1$I to engine', current_schema());
end $$;
-- Which metrics a platform reports, and since when, is a schema decision.
revoke insert on platform_metric from engine;

grant delete on party, property, deal, party_role, party_company, deal_property, deal_party,
	activity, activity_about, email, next_step, document, social_account, idea, design_template to engine;

-- Ids, created_at and the records a link or an about row joins never change; a different link is a removed row and a new one.
-- Who sent an activity and who owns a next step can be corrected.
grant update (label) on table role, phase to engine;
grant update (name) on party, deal, document, design_template to engine;
grant update (address) on property to engine;
grant update (title, started_on, ended_on) on party_company to engine;
grant update (happened_at, from_party_id, summary) on activity to engine;
grant update (what, owner_party_id, due_on, done_at) on next_step to engine;
grant update (status) on offer to engine;
grant update (handle) on social_account to engine;
grant update (angle, hook, pillar) on idea to engine;
grant update (status, platform_post_id, published_at) on post to engine;
