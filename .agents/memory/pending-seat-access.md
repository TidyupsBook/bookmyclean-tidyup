---
name: Pending seats grant nothing
description: How a self-signed-up staff member must resolve until somebody approves them, and why approval has to be one conditional update.
---

A staff member who signs themselves up with a company join code holds a seat
that must resolve to **the least-privileged role, with no company at all**.

**Why:** role and company are two separate things here. Resolving them as a
company member with a "pending" flag means every company-scoped route has to
remember to check that flag; one forgotten check leaks another tenant's data.
Resolving them as an owner-with-no-company (the shape used for a brand-new
signup) is just as wrong in the other direction — they sail through every
owner-guarded route and get whatever that handler does with a null company.

**How to apply:** withhold the company, and pick the weakest role. Two
consequences follow and are intended: a waiting applicant cannot create a
company of their own (the owner guard stops them, so no separate 409 check is
needed), and after approval their real role comes from whoever approved them.
Report the awaited company name as its own field so the UI can show a waiting
screen without that name implying access.

Approval must be a **single conditional update** whose WHERE pins the member id,
the approver's company, and the still-pending status — never read-then-write.
Two managers in the same office act on the same request within seconds of each
other; read-then-write lets both "succeed" with different roles, and lets an
approval land on a row a colleague just declined, which then dereferences a
missing row and records an outcome that never happened.
