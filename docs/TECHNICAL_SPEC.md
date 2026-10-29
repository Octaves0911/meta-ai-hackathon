# MeetPilot — Technical Specification (index)

Companion to [PRD.md](../PRD.md). The spec is split into focused documents:

| # | Document | Answers |
|---|---|---|
| 01 | [Architecture](01-architecture.md) | services, ports, stack, runtime flows, repo layout, env |
| 02 | [Data model](02-data-model.md) | tables, constraints, memory/search rules |
| 03 | [API & events](03-api-and-events.md) | REST, internal endpoints, Socket.IO, STT protocol |
| 04 | [AI pipeline](04-ai-pipeline.md) | extractor, retriever, judge, governor, agents |
| 05 | [UX design](05-ux-design.md) | layouts, components, tokens, states, a11y |
| 06 | [Security & privacy](06-security-and-privacy.md) | threats, controls, checklist |
| 07 | [Build plan](07-build-plan.md) | git workflow, feature branches, testing |
| 08 | [Operations](08-operations.md) | health, metrics, rate limits, logs, analytics events, process safety |

Key constants: caption fade 8 s · subtitle throttle 220 ms · worker tick 5 s · queue flush ≈8 s · governor 6 cards/30 min, 90 s cooldown (30 s conflicts) · agent revisions ≤3 · consultations ≤4, depth ≤2.
