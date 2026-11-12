# Glossary: Deals

The business's own words for the Deals board and the deal page. DoctorCRE is a two-partner brokerage that finds and negotiates space for healthcare clients. When a screen and the database disagree, the word on the screen wins. The database keeps its own names until the old system stops changing it (decision 1), so each term lists the names it matches today.

Each entry gives the meaning, the words to avoid, the database names, and the engine's name where it differs.

## People and companies

**Partner**:
One of the two brokers who own the business and sign in to the app.
_Avoid_: actor, user, seat
_Database_: `actor` (rows with `kind = 'human'`; the table also holds automations). Columns that name a partner hold the actor's `slug`: `deal.owner`, `v_deal_room_board.parked_by`, `account_owner`.
_Engine_: `partner` in `src/session.ts`; `actor` in `readBoard` and `readDealDetail`.

**Client**:
A healthcare practice or provider the partners represent. A client can be a person or an organization.
_Avoid_: customer, party, account
_Database_: `client`, joined to `party` for its name; `client_name`, `client_ref` and `client_id` in the deal views.

**Prospect**:
A client the partners are pursuing whose deal is still in the first phase, before the ETL is signed. An inactive prospect goes back to Leads.
_Avoid_: lead (a lead is on the Leads screen and is not yet a client), on-deck client
_Database_: `client.status = 'prospect'` with `client.prospect_engagement_status` (`active` or `inactive`); `v_client_engagement_status`.

**National account**:
A franchise or multi-location brand that the partners serve as one main client. Each of its locations is a sub-client with its own deals. One partner is its account owner.
_Avoid_: account client, parent client, brand, portfolio
_Database_: `client` with `client_type = 'national_account'`; `v_client_account.account_client_id`; `v_deal_room_account`; `national_account_owner`.
_Engine_: `account_client_id`, `account_name`, `account_owner`, and the `accounts` list on the board.

**Sub-client**:
One franchisee or location under a national account. It is a client of its own, and its deals attach to it, never to the national account.
_Avoid_: child client, franchisee record, line item
_Database_: a `client` whose party's `org_id` points at the national account's organization; `v_client_account.is_sub_client`.

**Contact**:
A person the partners deal with at a client or a vendor.
_Avoid_: party, person record
_Database_: `party` with `kind = 'person'`; `deal_participant` with role `client_contact`; the `contact` object in `v_deal_room_vendor`.

**Vendor**:
A company the partners bring onto a deal to do part of the work: lender, contractor, architect, attorney, title, inspector or landlord rep. The deal shows each vendor's company and contact under its role.
_Avoid_: service provider, party, partner
_Database_: `vendor`; `deal_vendor_assignment` (its `role` check lists the seven roles); `v_deal_room_vendor`.
_Engine_: `vendors` on the board and the deal page.

**Party**:
The database's word for any person or organization record. Clients, vendors, leads and contacts each point at one. It is not a business word, so screens and new code say client, contact, vendor or company.
_Avoid_ on screens and in new code: party
_Database_: `party`, with `kind` `person` or `org`; refs printed as `P-…`.

**Market agent**:
An outside broker assigned to work a national-account deal in its local market.
_Avoid_: agent on its own, referring agent (a different role on the deal)
_Database_: `deal_market_assignment.agent_name`.
_Engine_: `market_agent`.

## Deals

**Deal**:
One piece of brokerage work for one client, such as a lease, a purchase or a renewal. Its name on the board is a short name when the client is a doctor and the market is known, such as "Dr. Example's Springfield Deal".
_Avoid_: deal room (the old app's name), work record, record, deal space (in the old system that means a saved space search for a deal), transaction
_Database_: `deal`; `v_deal_room_board` and `v_open_deal_room_board` for open deals; `v_deal_board` for closed and lost deals; the other `v_deal_room_*` views for a deal's parts. The type is `deal.deal_type`, with labels in `deal_type_ref`.
_Engine_: `type` for the deal type; `short_name` for the name the board shows.

**Local deal**:
A deal whose client is not under a national account. The partners work these themselves.
_Avoid_: team deal, territory deal, workspace
_Database_: `workspace_kind = 'team'` in `v_deal_room_board` and `deal_review_session`. A separate column, `deal.lane`, carries the old Salesforce flag (`territory` or `national`).
_Engine_: `workspace: "team"` in `readBoard`.

**Deals board**:
The screen that lists every open deal by phase, with Local Deals and National Accounts tabs and separate lists of closed and lost deals.
_Avoid_: pipeline, Kanban, Deal Room
_Database_: `v_open_deal_room_board`, `v_deal_board`, `v_deal_room_account`.
_Engine_: `readBoard` in `src/deals/board.ts`, answer `local-deals-board.v2`.

**Deal page**:
The screen for one deal: its phase, owner, next step, vendors, critical dates, lease, history and notes.
_Avoid_: deal room, record panel, deal detail, timeline
_Database_: the `v_deal_room_*` views for one `deal_id`.
_Engine_: `readDealDetail` in `src/deals/detail.ts`, answer `deal-timeline.v1`.

**Phase**:
Where a deal stands. The screens show eight, in order: Prospective Client, Research, Site Selection, Negotiating, Legal, Due Diligence, Closing, Closed.
_Avoid_: stage (leads have stages), column, status, On Deck, Pending, Diligence
_Database_: `deal.phase` and `deal_phase`, slugs `pending`, `research`, `site_selection`, `negotiation`, `legal`, `due_diligence`, `closing`, `closed`.

**Owner**:
The partner responsible for a deal.
_Avoid_: lead (a participant role that means owner), assignee
_Database_: `deal.owner` for open deals. Closed and lost deals take it from `deal_participant` with role `lead`, shown as `v_deal_board.lead_owner`.
_Engine_: `owner` in both places.

**Market**:
The local area where the client needs space.
_Avoid_: city, territory, submarket
_Database_: `deal.city`, shown as `market` in `v_deal_room_board`.
_Engine_: `market` on the board; the deal page renames it back to `city`.

**Next step**:
The one thing that has to happen next on a deal, with its date. A deal without both is missing its next step.
_Avoid_: next action, task, to-do
_Database_: `next_step` and `next_date` in `v_deal_room_board`, built from `next_action` and `deal_note` (kind `next_step`); `deal.next_date`.
_Engine_: `next_step`, `next_date`, `next_step_required`; open actions also appear as `open_actions` and `next_actions`.

**Critical date**:
A date in the deal or its lease that must not be missed, such as a due-diligence deadline or a lease expiration.
_Avoid_: deadline, milestone, key date
_Database_: `critical_date`; `v_deal_room_critical_date`.
_Engine_: `critical_dates`.

**Flagged for attention**:
A deal a partner has marked as needing a look now.
_Avoid_: blocker, urgent, hot
_Database_: `deal.attention`.
_Engine_: `attention`.

**Parked**:
A deal that is not active work for now, with a reason. Parking keeps the deal; reviving it makes it active again.
_Avoid_: on hold, inactive, archived, paused
_Database_: `deal.operating_state` (`active` or `parked`), `parking_reason` (`prospect_never_active`, `client_paused`, `other`), `parking_note`, `parked_at`, `parked_by`.
_Engine_: `operating_state`.

**Outcome**:
How a finished deal ended: won, lost or paused. A closed deal also carries its closing date, and its invoice date once it is billed.
_Avoid_: result, status, disposition
_Database_: `deal.outcome` (`won`, `lost`, `paused`), `deal.closed_on`, `deal.invoiced_on`, `deal.won_value`.
_Engine_: `closed_deals` and `lost_deals` on the board.

**Deal review**:
A sitting in which a partner goes through the open local deals, or one national account's deals, and marks each reviewed or skipped.
_Avoid_: session, agenda, review session
_Database_: `deal_review_session` and `deal_review_item`; `v_deal_room_session`; `last_review_at` in `v_deal_room_board` and `v_deal_room_account`.
_Engine_: `open_session` on the board.

## Questions for the owner

1. The first phase column. Should it say "Prospective Client" or "On Deck"?
2. A deal whose old Salesforce flag says national but whose client is not under a national account. Is it a local deal or a national deal?
3. A deal's market. Is it a city or a metro area?
4. A "paused" outcome. Is that deal finished, or should it be parked instead?
5. A franchisee's own client record. Do you call it a "sub-client" or a "location"?
