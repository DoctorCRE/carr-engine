-- The new database's core, designed in docs/new-database.md. Nothing applies it to a live database.
-- It names no schema, so a loader chooses the namespace with search_path.

create table party (
	id uuid primary key default gen_random_uuid(),
	kind text not null check (kind in ('person', 'company')),
	name text not null
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

create table property (
	id uuid primary key default gen_random_uuid(),
	address text not null
);

create table deal (
	id uuid primary key default gen_random_uuid(),
	name text not null
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

create table document (
	id uuid primary key default gen_random_uuid(),
	name text not null,
	r2_key text not null
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
		check (status in ('open', 'countered', 'accepted', 'rejected', 'withdrawn')),
	rent_per_sf_yr numeric(10, 2),
	term_months integer,
	ti_per_sf numeric(10, 2),
	free_rent_months numeric(4, 1),
	escalation_pct numeric(5, 2),
	commencement_on date,
	other_terms text,
	check (answers_round < round),
	unique (deal_id, round),
	foreign key (deal_id, property_id) references deal_property,
	foreign key (deal_id, from_party_id, from_role) references deal_party,
	foreign key (deal_id, answers_round) references offer (deal_id, round)
);

create unique index offer_one_accepted_per_deal on offer (deal_id) where status = 'accepted';

create function offer_keeps_its_terms() returns trigger
language plpgsql as $$
begin
	if to_jsonb(new) - 'status' <> to_jsonb(old) - 'status' then
		raise exception 'a round is never rewritten; add the next round' using errcode = 'check_violation', constraint = 'offer_keeps_its_terms';
	end if;
	return new;
end $$;

create trigger offer_keeps_its_terms before update on offer
	for each row execute function offer_keeps_its_terms();

create table offer_document (
	offer_id uuid not null references offer,
	document_id uuid not null references document,
	primary key (offer_id, document_id)
);

create function everything_about_deal(wanted uuid) returns jsonb
language sql stable
begin atomic
	select jsonb_build_object(
		'deal', to_jsonb(d),
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
		)
	)
	from deal d
	where d.id = wanted;
end;
