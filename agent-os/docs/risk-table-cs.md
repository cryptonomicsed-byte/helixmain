# Risk table: Customer Service agent actions

Every ActionProposal carries a `risk` field. The policy engine maps
capability + risk to a verdict. This table is the Phase 0 policy seed for
the first commercial agent.

## LOW — auto-execute (PolicyDecision: allow)

- answer from approved knowledge base
- retrieve customer record (read-only)
- retrieve order / shipment status (read-only)
- create support ticket
- update ticket with conversation summary
- summarize conversation for handoff notes
- send a reply from the approved response set

## MEDIUM — policy check, then execute or escalate

- draft a reply outside the approved set → model-judge verification, then send
- schedule / reschedule an appointment (writes to a third-party calendar)
- issue store credit below threshold ($25)
- merge duplicate customer records

## HIGH — human approval required (PolicyDecision: approval_required)

- refund (any amount)
- account modification (address, payment method, plan change)
- cancellation of an order / subscription / contract
- any financial transaction or money movement
- sending a message the customer did not solicit (outbound)

## ALWAYS ESCALATE — deny autonomous execution

- security incident (suspected breach, credential leak)
- legal threat or request for legal advice
- ambiguous customer identity that verification cannot resolve
- sensitive dispute (discrimination, harassment, medical, safety)
- any action outside the agent's `permissions` map (deny by default)

## Notes

- Thresholds ($25 store credit, etc.) are per-tenant overrides on this table.
- Every MEDIUM/HIGH action mints a receipt with the approval record attached.
- The human approval queue is itself a worker (`human` type in the registry).
