# Glossary: Deals

The business's own words for the deal board and the deal page. DoctorCRE is a two-partner brokerage that finds and negotiates space for healthcare clients. The owner's wording is the authority. Where a screen and the database disagree, the screen's word wins. The database keeps its own names until the old system stops changing it (decision 1), so each term lists the names it matches today.

Each entry gives the meaning, the words to avoid, the database names, and the engine's name where it differs.

## People and companies

**Partner**:
One of the two partners, signed in to the app.
_Avoid_: actor, user
_Database_: `actor` (rows with `kind = 'human'`; the table also holds automations). Columns that name a partner hold the actor's `slug`: `deal.owner`, `v_deal_room_board.parked_by`, `account_owner`.
_Engine_: `partner` in `src/session.ts`, `src/answer.ts`, `src/deals/routes.ts` and `readBoard`; the board answer keeps the old `actor` key.

**Client**:
Any person or company we represent on a transaction.
_Avoid_: customer, party, account
_Database_: `client`, joined to `party` for its name; `client_name`, `client_ref` and `client_id` in the deal views.

**Prospect**:
The stage in between lead and client. A lead becomes a prospect when it turns warm, or a potential client becomes one when introduced. It stays a prospect until we represent them. An inactive prospect goes back to Leads.
_Avoid_: lead (still on the Leads screen), on-deck client
_Database_: `client.status = 'prospect'` with `client.prospect_engagement_status` (`active` or `inactive`); `v_client_engagement_status`.

**National account**:
A franchise or multi-location brand that we serve as one main client. One partner is its account owner. Each location is a franchisee with its own deals. A deal outside our territory is likely a national-account deal.
_Referral_: another Carr agent who owns a national account can refer one of its deals to a partner. The deal is then in our market, but that agent owns the account, not us.
_Avoid_: account client, parent client, brand, portfolio
_Database_: `client` with `client_type = 'national_account'`; `v_client_account.account_client_id`; `v_deal_room_account`; `national_account_owner`. The old Salesforce flag `deal.lane` (`territory` or `national`) can disagree with whether the client sits under a national account.
_Engine_: `account_client_id`, `account_name`, `account_owner`, and the `accounts` list on the board.

**Franchisee**:
One location under a national account. Its record is also called a location. Its deals attach to it, never to the brand.
_Accept_: location
_Avoid_: sub-client, child client, line item
_Database_: a `client` whose party's `org_id` points at the national account's organization; `v_client_account.is_sub_client`.

**Vendor**:
An individual or company who plays a role in the transaction or provides services to our clients: lender, contractor, architect, consultant, attorney, title, inspector, and so on. The deal shows each vendor's company and contact under its role.
_Avoid_: service provider, party, partner
_Database_: `vendor`; `deal_vendor_assignment.role`, whose check allows `lender`, `contractor`, `architect`, `attorney`, `title`, `inspector` and `landlord_rep` (no `consultant` yet); `v_deal_room_vendor`.
_Engine_: `vendors` on the board and the deal page.

**Listing agent**:
An agent or broker representing the property owner.
_Avoid_: listing side, landlord rep
_Database_: on a deal, `deal_participant` with role `listing_side`; on a building, `building_ownership.kind = 'listing_agent'`. The vendor role `landlord_rep` is a separate, similar role.

**Market agent**:
A Carr agent working a national-account deal in their local market.
_Avoid_: agent on its own, outside broker, referring agent (a different role on the deal)
_Database_: `deal_market_assignment.agent_name`.
_Engine_: `market_agent`.

**Party**:
The database's word for any person or organization record. Clients, vendors, leads and contacts each point at one. It is not a business word, so screens and new code say client, contact, vendor or company.
_Avoid_ on screens and in new code: party
_Database_: `party`, with `kind` `person` or `org`; refs printed as `P-…`.

## Deals

**Deal**:
One piece of brokerage work for one client, such as a lease, a purchase or a renewal. Its name on the board is a short name when the client is a doctor and the market is known, such as "Dr. Example's Springfield Deal".
_Avoid_: deal room (the old app's name), work record, record, deal space (in the old system that means a saved space search for a deal), transaction
_Database_: `deal`; `v_deal_room_board` and `v_open_deal_room_board` for open deals; `v_deal_board` for closed and lost deals; the other `v_deal_room_*` views for a deal's parts. The type is `deal.deal_type`, with labels in `deal_type_ref`.
_Engine_: `type` for the deal type; `short_name` for the name the board shows.

**Local deal**:
A deal whose client is not under a national account. The partners work these themselves.
_Avoid_: team deal, territory deal, workspace
_Database_: `workspace_kind = 'team'` in `v_deal_room_board` and `deal_review_session`.
_Engine_: `workspace: "team"` in `readBoard`.

**Deal board**:
The screen that lists every open deal by phase, with Local Deals and National Accounts tabs and separate lists of closed and lost deals.
_Avoid_: Deals board, pipeline, Kanban, Deal Room
_Database_: `v_open_deal_room_board`, `v_deal_board`, `v_deal_room_account`.
_Engine_: `readBoard` in `src/deals/board.ts`, answer `local-deals-board.v2`.

**Deal page**:
The screen for one deal: its phase, deal owner, next step, vendors, critical dates, lease, history and notes.
_Avoid_: deal room, record panel, deal detail, timeline
_Database_: the `v_deal_room_*` views for one `deal_id`.
_Engine_: `readDealDetail` in `src/deals/detail.ts`, answer `deal-timeline.v1`.

**Phase**:
Where a deal stands. There are eight, in order: Prospective Client, Research, Site Selection, Negotiating, Legal, Due Diligence, Closing, Closed.
_Avoid_: stage (leads have stages), column, status, On Deck, Pending, Diligence
_Database_: `deal.phase` and `deal_phase`, slugs `pending`, `research`, `site_selection`, `negotiation`, `legal`, `due_diligence`, `closing`, `closed`.

**Deal owner**:
The partner responsible for a deal.
_Avoid_: owner on its own, lead (a participant role that means deal owner), assignee
_Database_: `deal.owner` for open deals. Closed and lost deals take it from `deal_participant` with role `lead`, shown as `v_deal_board.lead_owner`.
_Engine_: `owner` in both places.

**Market**:
The city or metro area where the client needs space.
_Avoid_: territory, submarket
_Database_: `deal.city`, shown as `market` in `v_deal_room_board`.
_Engine_: `market` on the board; the deal page renames it back to `city`.

**Critical date**:
A date in the deal or its lease that must not be missed, such as a due-diligence deadline or a lease expiration.
_Avoid_: deadline, milestone, key date
_Database_: `critical_date`; `v_deal_room_critical_date`.
_Engine_: `critical_dates`.

**Parked**:
A deal that is not active work for now, with a reason. Parking keeps the deal; reviving it makes it active again. A paused deal is parked.
_Avoid_: on hold, inactive, archived, paused
_Database_: `deal.operating_state` (`active` or `parked`), `parking_reason` (`prospect_never_active`, `client_paused`, `other`), `parking_note`, `parked_at`, `parked_by`.
_Engine_: `operating_state`.

**Pipeline call**:
A sitting where a partner goes through the open deals and marks each reviewed or skipped.
_Avoid_: deal review, session, agenda
_Database_: `deal_review_session` and `deal_review_item`; `v_deal_room_session`; `last_review_at` in `v_deal_room_board` and `v_deal_room_account`.
_Engine_: `open_session` on the board.
