# The new database

The engine will move to a new, cleanly connected database in one planned step, after it serves every screen from today's database. This note designs the core. `schema/next.sql` holds the first slice. Tests load it into its own namespace in a throwaway database with made-up data. Nothing applies it to a live database.

## Records

- **`party`**: every person and company, once, each with its own id. `kind` is `person` or `company`.
- **`role`**: the short list of roles, such as client, lead, vendor, lender, listing agent and property owner. The partners can rename a label without touching any record.
- **`property`**: a building or space, by address.
- **`deal`**: one piece of brokerage work.
- **`phase`**: the list of deal phases, from negotiating to closed, plus dead. Like roles, a label can be renamed.
- **`deal_phase_change`**: one row each time a deal changes phase, with when, the new phase and the reason. A deal's phase is its latest row.
- **`offer`**: one round of an LOI or other offer on a deal.
- **`document`**: a file, as its name and its key in object storage (Cloudflare R2). The file itself is never in the database. An email attachment names the email it arrived with.
- **`activity`**: something that happened: an email, a call, a meeting or a note, with when, who it came from and a summary.
- **`email`**: the email behind an email activity.
- **`next_step`**: what is due next, with its owner, due date and the time it was done.

Each record and link carries `created_at`, when its row was stored, so moving today's records across can keep their dates. Lists such as roles and phases do not, and neither do rows that carry their own time: activities and their emails, rounds, phase changes, posts and readings.

## Links

Each link is one row. No record holds a list or a column per role.

- **`party_role`**: what a person or company is to us. One row per role.
- **`party_company`**: a person at a company, with their title there and the dates they started and left. A person who moves keeps the old row, with its end date, and gets a new one.
- **`deal_party`**: who is on a deal, in which role. The client, the listing agent and each vendor are rows here.
- **`deal_property`**: the properties a deal is considering.
- **`offer_document`**: the documents of each round.
- **`activity_about`**: each deal, person or company, or property an activity concerns.

## Rules the database enforces

Each rule has a test in `src/next-database.test.ts` that fails without it. The tests work as the engine's role (see "Who may change what"), so each refusal is a constraint, a trigger that checks values, or a privilege the role lacks.

1. A link to a record that does not exist is refused, and so is deleting a record something still links to.
2. Every role on a person or a deal comes from the role list.
3. The same link is stored once.
4. A person or company is one of the two kinds.
5. A round's number is used once per deal, and a round answers an earlier round of the same deal.
6. A round comes from someone on the deal, in their role on that deal, about a property the deal is considering.
7. A round is never rewritten or removed, not even by emptying the table. Only its status changes. New terms are the next round, and `withdrawn` takes a round back.
8. At most one round per deal is accepted at a time.
9. Rent, NNN, term, TI, free rent, the escalator and days after delivery are never negative.
10. A round's status moves only out of `open`, or from `accepted` to `superseded`. Every other status is final. A round is superseded only when a later round of the same deal is accepted, checked when the change is saved.
11. Rent starts on a date or a number of days after delivery, never both.
12. A person-at-company link joins a person to a company, ends no earlier than it starts, and is stored once.
13. A deal's phase changes are never rewritten or removed, each phase comes from the list, and a move to dead says why.
14. An activity is an email, a call, a meeting or a note. Each `activity_about` row names exactly one deal, party or property, and is stored once.
15. An email's Message-ID is stored once and never has spaces around it, an email belongs to an email activity, and an attachment names an email. An email is about at least one record, checked when the change is saved, so an email about nothing is refused and so is removing, moving or emptying away its last link.
16. A next step is about exactly one deal, party or property.
17. A social account is on a known platform, its handle is not blank, and a handle is used once per platform, in any case.
18. A post is on its account's platform and is scheduled, published or failed. Only a published post has the platform's post id and its publish time, and that id is stored once per account.
19. A post is never removed, and a published or failed post never changes. A retry is a new post.
20. A reading is of a published post, taken no earlier than it was published, of a metric its platform reports, and never negative. It names its source. A reading that could not be taken has a reason and no value, never a zero. A source or reason is never blank.
21. A reading is stored once and never rewritten or removed.
22. Each platform's reported metrics come from the known platforms and metrics, each once, with the time from which posts must have it, and only a schema change adds one.
23. A record or link keeps when it was stored.
24. The engine empties no table, removes no history, and changes only the columns that may change.

Two people adding different links to one deal at the same time both keep theirs, because each link is its own row. A test proves it with two open sessions.

## Who may change what

`schema/next.sql` defines `engine`, the role the engine will use on this database. A login takes it with `grant engine to <login>`. The engine connects with `role=engine` set, or as a login created in SQL. A role made in the Neon console belongs to `neon_superuser`, and its own rights would bypass these grants. Loading the schema refuses an existing `engine` role that is a member of any role, is a superuser, bypasses row security, or can create roles or databases or replicate.

The role reads rows in every table, adds rows in every table except `platform_metric`, and empties none. It removes rows only outside history, and changes only these columns:

- a role's or a phase's label;
- a party's, deal's, document's or design template's name, and a property's address;
- a person-at-company link's title and dates;
- an activity's time, sender and summary;
- a next step's text, owner, due date and done time;
- a round's status;
- a social account's handle, and an idea's angle, hook and pillar;
- a scheduled post's status, platform post id and publish time.

History is `deal_phase_change`, `offer`, `offer_document`, `post` and `measurement`. Ids, `created_at`, and the records a link or an about row joins never change; a different link is a removed row and a new one. Who an activity came from and who owns a next step can be corrected. PostgreSQL refuses anything else before it touches a row, so a save runs no trigger just to be told no. The triggers left check values: a round's status moves, a later acceptance superseding a round, an email about a record, a post that is no longer scheduled, and a reading of a published post.

The owner's own login can still change anything. That path is not the engine's concern.

## Offer rounds

Every LOI, counter and response is a new `offer` row. It holds its round number, the round it answers, who sent it and in what role, when, and its status: `open`, `countered`, `accepted`, `rejected`, `withdrawn` or `superseded`. The standard terms are typed columns, so the app can show what changed from one round to the next: rent and estimated NNN per square foot per year, term in months, TI per square foot, free rent months, yearly escalation percent, and when rent starts, as a date or as a number of days after delivery. Each later term is one more column.

`everything_about_deal` returns a deal's phase changes in order, its properties, its people with their roles, its rounds in order with their documents, its activity in time order with each email and its attachments, and its next steps by due date, in one read. The property reaches the deal through `deal_property`, and the client and the listing agent through `deal_party`.

## Owner decision: unusual one-off terms

Some LOIs carry a term no other deal has, such as an exclusive-use clause. There are two ways to keep it:

- **A plain text field on each round.** This is built and recommended. It keeps one place, is easy to read, and the document holds the exact wording.
- **A row per extra term**, each with a name and a value. Each term could then be compared round to round, at the cost of another table and a name for every term.

Unusual terms are rare and are read by people, not computed, so the text field is enough.

## When a deal falls apart

A round's status records what happened to that round, and the deal's phase records where the deal stands. An accepted round stays accepted when the deal later dies. The deal moves to the dead phase, with a date and a reason, and nothing is deleted. If talks restart, the deal moves to a live phase again and the new rounds answer the last one. When a new round is accepted, the earlier accepted round becomes `superseded` in the same save, so a deal has one current accepted round. An accepted round is never superseded on its own. A mistaken status is fixed by a new round, as a mistaken term is.

## Activity, emails and next steps

- **`activity`** records something that happened. **`activity_about`** links it to each deal, person or company, or property it concerns, one row each. One email about a deal, its client and its lender shows on all three timelines.
- **`email`** holds the message's own Message-ID header (Outlook's `internetMessageId`), never an id one mailbox gives it, so mail both partners received is stored once. The id is unique, keeps its case, and is refused with spaces around it. The row also holds the sender, the subject and the new text only, with quoted history removed. The date is the activity's time. The agent stores only an email it ties to a record. Mail that matches nothing stays in the mailbox and is not copied, and the database refuses an email that is about no record. The original mailbox stays the full record.
- **Attachments** go to R2. Each becomes a `document` that names the email it arrived with.
- **`next_step`** is about exactly one deal, person or company, or property. Its owner is a party.
- A step with no owner may be a partner's own, because partners become parties only in a later slice.

A row that may point at one of several kinds of record has one checked key per kind and a check that exactly one is set. It never holds a type word and an id the database cannot check (decision 21). Activity and next steps are not history: a note can be corrected, and a step is marked done.

Size, as reasoning: a stored email is a few kilobytes of plain text, without attachments or quoted history, and only mail about a record is kept. So the table grows with deal work, not with mailbox traffic. Files grow in R2.

## Worked example: an LOI response by email

The partners toured 100 Example Way with their client and sent an LOI. The listing agent emails back with a counter.

1. The client and the listing agent are each a `party`, with `party_role` rows for client and listing agent.
2. The property is a `property`, linked to the deal by `deal_property`.
3. On the deal, `deal_party` holds the client as client and the agent as listing agent.
4. Our LOI is round 1, sent by the client.
5. The agent's email becomes an `activity` from the agent, with its `email` row and `activity_about` rows for the deal and the agent.
6. The attached PDF goes to R2 and becomes a `document` that names the email.
7. The counter is round 2. It comes from the agent as listing agent, answers round 1, carries its own terms, and links the PDF in `offer_document`. Round 1 becomes countered.
8. Our response is round 3. The agent's acceptance marks it accepted.
9. A `next_step` on the deal says to start the lease draft.

The tests run rounds 1 to 3, the acceptance, the email with its attachment, a call and the next steps, and read them back in order.

## Marketing

The owner's automation keeps posting as it does today. These tables record what went out and how each post did, so each week's posts can learn from earlier ones.

- **`social_account`**: a partner's presence on X, LinkedIn, Facebook or Instagram, by its handle, owned by a party. "Account" alone means a national account (`docs/glossary.md`).
- **`idea`**: what a post says, as its angle, hook and pillar. One idea can run on several accounts.
- **`design_template`**: a reusable look that a post's image is made from.
- **`platform_metric`**: the metrics each platform reports, one row each. LinkedIn and X do not report saves, for example. The rows are a guess, to be confirmed against each platform's API. Each row says from when posts must have the metric. The first rows hold from the start, and a row added later holds from when it is added, so older posts, which have no reading of it, stay in the day-7 comparison. Only a schema change adds one.
- **`post`**: one post on one account, with its idea, its design template, when it was scheduled, and its status. A post without an idea or a template still counts for its account.
- **`measurement`**: one reading of one metric of a post: when it was taken, its source and its value. A reading of a metric the post's platform does not report is refused, and so is a reading before the post is published. A reading that could not be taken is stored as not measured, with its reason, so a gap never reads as zero.

Ratios are calculated when read, never stored. Engagement is the sum of the reactions, comments, shares and saves that the post's platform reported when it was published, and engagement per view divides it by views.

`posts_at_day_7(as_of)` compares posts at the same age, because a post's numbers keep growing for days. Each post is judged by its latest reading of each metric at or before 168 hours after it was published. It returns, per account, how many posts it compared and the best and worst by engagement per view.

A post is left out while it is younger than 7 days, when it has no reading by day 7 of views or of an engagement metric its platform reports, or one whose latest reading by day 7 was not measured, or when it had no views.

Best and worst stay within one account, so they compare like with like. Averages per idea and design template come next (#206). They can mix platforms that count engagement differently, so each will show how many of its posts are on each platform.

Each ranked post carries `reading_age_hours`, the age of the oldest reading it was judged on. A post read only on day 3 shows 72, so the weekly loop and the Marketing screen can see it was judged early.

Pillars and hooks are text for now. They become lists, like roles and phases, with the rotation rules.

## Later slices

Partners as people, and who changed what. Deal type, owner and dates. Emails and phone numbers per person. Merging duplicates. "Everything about this person." Leads and their conversion to clients. National accounts and franchisees. Leases, critical dates and commissions. Change history. Indexes, once real sizes are known. Moving today's records across, where the old party kind `org` becomes `company`. For marketing: rotation rules, lead attribution and the weekly agent loop.
