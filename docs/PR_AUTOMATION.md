# PR review, approval, merge and cleanup

The reusable workflows in this repository serve only `bdstark/gma3-mcp`, `bdstark/gma3-beat-sync` and
`bdstark/gma3-phrase-sync`, plus `bdstark/gma3-surface`. Callers pin an immutable revision. Each job fetches only the shared automation directory
from its pinned controller revision. The candidate repository is fetched separately with trusted main checked out; PR commits are inspected as data using git diff/show, under its own
licence and repository guidance. No product implementation is transferred between repositories.

## Setup and rollout

1. In each repository, add **Settings → Environments → codex-review → Add environment secret** named
   `OPENAI_API_KEY`. This is separately billed OpenAI API usage; do not put the key in a file or comment.
2. Add Actions variables `PR_AUTOMATION_ENABLED=true` and `PR_MERGE_ENABLED=false` to start in review-only mode.
3. Merge the workflow PRs manually after review. Workflow/policy changes deliberately cannot merge themselves.
4. Run **Actions → PR automation → Run workflow**, optionally entering a PR number. Check the independent review
   and the official review on the same head. All triggers, including manual dispatch, reuse the verified independent review until the head or base changes. The job rechecks under its per-PR lock before any paid review. Missing credentials or malformed/incomplete output never authorizes a merge.
5. Before enabling merges, test a clean PR, an actionable finding followed by a fix, failing CI, an intervening head/base
   change and stacked cleanup. Unit tests cover the controller's acceptance and cleanup boundaries; a real Actions
   smoke run is still required. Keep the chat monitor until those checks pass.
6. Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull
   requests**, leaving the default token permission read-only. Set `PR_MERGE_ENABLED=true` only after the smoke test.
   The workflow requests write access only in its publisher/controller jobs. It uses `GITHUB_TOKEN`, not an administrator
   or personal bypass token. GitHub branch protections still apply. No GitHub App private key is needed.

## Review and acceptance

The existing CI remains responsible for deterministic builds/tests. The additional Codex Action job independently
inspects the diff, requirements, tests, documentation and edge cases in a read-only offline sandbox. It does not execute
candidate scripts with API credentials and does not contact live consoles or players. It posts actionable P0–P3 findings
with locations and scenarios, or a structured ready/incomplete verdict. It is a second model pass, not a human reviewer,
and it does not claim to have run the project's tests itself.

Approval and squash merge require all of the following:

- Owner-authored (`bdstark`), non-draft, same-repository PR targeting `main`.
- Current head **and base** match the independent review. No actionable independent findings.
- A completed, clean official Codex code review on that head; phrase-sync and beat-sync also require their enabled
  Security Review. MCP accepts an absent Security Review because it is currently disabled there.
- No unresolved review discussions.
- Latest `CI` run succeeds for this PR, head and current base; MCP also requires the current-head `CodeQL` check from
  GitHub Advanced Security, with no failing/pending commit statuses.
- GitHub reports the PR mergeable. GitHub enforces any additional required checks and approvals when the API merges.
- Neither old nor new filenames touch `.github`, `.codex` or `AGENTS.md`. Those policy changes require manual review/merge.

Official summary comments use the observed `codex-review-state:v1` payload, which is not a documented stable API.
Unknown/malformed or missing summary fields hold the merge. A 👍 reaction by itself never authorizes merging.
Independent receipts also verify the GitHub Actions bot identity and source workflow run; a user-authored copy does not count.
Forks, other authors and stacked bases remain manual in this initial rollout. Private-repository ruleset availability may
depend on the GitHub plan; the controller's tests/guards are not a substitute for server-side branch protection.

There is no timer. PR events (including base edits), official summary comments, CI completion and updates to `main` drive reevaluation.
Review submissions, edits and dismissals use a separate secret-free, permission-free notification workflow. Its
completion triggers the privileged workflow from the default branch; no PR artifacts or code are consumed.
A manual dispatch can retry an incomplete review or a merged PR's cleanup. If resolving discussions is the final
change, post `/accept` as bdstark to reevaluate the gates without rerunning a completed independent review. GitHub
Actions does not expose the review-thread-resolution webhook as a supported workflow trigger. Actions-generated approvals/comments do not
need to trigger another workflow: the current controller performs the merge directly after all gates pass. Native GitHub
`allow_auto_merge` is not required for this direct, SHA-guarded merge path.

## Cleanup and stacked PRs

Merge and cleanup jobs serialize repository-wide and recheck eligibility after acquiring that serialization.
They use `queue: max` so pending jobs are retained (GitHub limits this queue to 100; excess jobs need a new dispatch).
A fresh non-ready independent verdict vetoes acceptance even when an older ready receipt exists. GitHub
mergeability that is temporarily unknown is polled four times at three-second intervals before holding the PR.
After an automated merge the controller explicitly dispatches another scan: GITHUB_TOKEN pushes alone do not trigger
new workflows. Other PRs whose CI base is stale still need rebase/current-base CI before acceptance.

After merge, cleanup only handles a source branch in the same repository whose tip still equals the merged head.
Deletion uses a Git receive-pack SHA lease rather than an unconditional REST delete, so advancement between the read
and deletion is rejected atomically. Protected, advanced and default branches are retained. For stacked PRs it first retargets their base to the merged PR's
base and retains the parent branch for recovery. Rebase the children and rerun CI/review; then dispatch cleanup for the
merged parent PR. Cleanup does not rewrite dependent branches or blindly delete them.

## Maintenance and stop switch

Set `PR_MERGE_ENABLED=false` to stop approval/merge/cleanup while retaining reviews. Set `PR_AUTOMATION_ENABLED=false`
to stop the service entirely. Neither switch cancels a mutation already sent to GitHub. Leave repository automatic branch
deletion off while using the stack-aware controller.

Use strict up-to-date required CI protection where available, and avoid concurrent manual writes to main during
automatic acceptance; repository-wide serialization covers this controller, not external maintainers.

Controller tests: `node --test .github/automation/controller.test.cjs`. Workflow validation: `actionlint` (older releases do not recognize GitHub’s documented `concurrency.queue`;
use a current release or ignore only that known syntax diagnostic).
When changing the controller, commit it first and bump the immutable controller ref in both reusable workflows; then
commit the workflows and bump each consumer's reusable-workflow ref. Review those changes manually.

## Protected API key

Add `OPENAI_API_KEY` under Settings → Environments → **codex-review** → Environment secrets. This environment permits only the **main branch** (custom branch policy, no tag rules), rejecting PR merge refs and feature branches. The independent job receives this environment secret directly; callers explicitly forward the secret name through each reusable-workflow boundary; the main-only environment supplies its value. Remove the repository-level OPENAI_API_KEY copy: repository secrets remain available to PR-authored same-repository workflows regardless of the intended listener permissions. Do not enable reviews until the environment secret is populated. Missing credentials fail closed. Workflow/policy changes require review before reaching main.

GitHub requires explicit named-secret forwarding at every reusable-workflow boundary even for environment-only secrets. This does not restore a repository secret; codex-review remains the only key store.
