- codegraph-vs-graphify.md --> how about Serena?
- **Performance Metrics**: `hallucination_detected`, `rework_cycles`, `defects_found` are logged automatically by `hooks/task_completion_metrics.py` --> .claude/session-metrics.json
- Concurrency?
- .claude/memory/
- feedback learning
- Mutation Testing skill (referenced by software engineer.md)
- per Model/Effort Resolution in code-review
- code-review complete -> test-improve -> coverage-baseline -> scripts
                mutation-testing
                coverage-delta
                mutation-kill
                quality-targets-converge
- Detect and read rules from the target repository:
    - `CLAUDE.md`
    - `.clinerules`
    - `.claude/rules/index.md`
    - `CONTRIBUTING.md`
- `hooks/verify_guard.py`
- `build_slice_scope.py`