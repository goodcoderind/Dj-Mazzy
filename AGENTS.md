# Mazzy workspace instructions

Before changing audio analysis, track sequencing, transition planning,
automatic mixing, transport timing, DSP, party UX, or AI behavior, read
`AI_DJ_RESEARCH_AND_BUILD_PLAN.md` completely.

Treat that file as the canonical product and engineering specification:

- Keep research findings, decisions, hypotheses, and targets distinct.
- Update the specification and decision log when evidence changes the plan.
- Version stored analysis and transition schemas when behavior changes.
- Keep the Web Audio clock authoritative; UI timers must not schedule audio.
- Never hide low-confidence analysis. Use a documented safe fallback.
- Do not add music services, models, or DSP libraries without checking their
  current terms, code licence, model-weight licence, and distribution impact.
- Preserve the local-first privacy model unless the user explicitly changes it.
- Validate audio work with deterministic renders, metrics, and listening tests.
- Do not claim a milestone is complete until its acceptance criteria pass.
